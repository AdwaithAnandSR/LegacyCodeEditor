#pragma once

#include "HybridEditorEngineSpec.hpp"
#include "SyntaxEngine.hpp"
#include <limits>
#include <memory>
#include <string>
#include <vector>
#include <stack>
#include <optional>
#include <functional>
#include <regex>
#include <sstream>
#include <algorithm>
#include <numeric>
#include <cmath>
#include <cstring>
#include <cstdint>

namespace margelo::nitro::editorengine {

// ─── UTF-8 / UTF-16 Code Unit Conversion Utilities ────────────────────────────

namespace utf8_util {

inline size_t utf16LengthSlice(const char* data, size_t n) {
    size_t len = 0;
    size_t i = 0;
    while (i < n) {
        unsigned char c = static_cast<unsigned char>(data[i]);
        if (c < 0x80) {
            i += 1;
            len += 1;
        } else if ((c & 0xE0) == 0xC0) {
            i += (i + 2 <= n) ? 2 : (n - i);
            len += 1;
        } else if ((c & 0xF0) == 0xE0) {
            i += (i + 3 <= n) ? 3 : (n - i);
            len += 1;
        } else if ((c & 0xF8) == 0xF0) {
            i += (i + 4 <= n) ? 4 : (n - i);
            len += 2;
        } else {
            i += 1;
            len += 1;
        }
    }
    return len;
}

inline size_t utf16Length(const std::string& str) {
    return utf16LengthSlice(str.data(), str.size());
}

inline size_t utf16ColumnToByteOffsetSlice(const char* data, size_t n, size_t utf16Col) {
    if (utf16Col == 0 || n == 0) return 0;
    size_t currentU16 = 0;
    size_t i = 0;
    while (i < n && currentU16 < utf16Col) {
        unsigned char c = static_cast<unsigned char>(data[i]);
        if (c < 0x80) {
            i += 1;
            currentU16 += 1;
        } else if ((c & 0xE0) == 0xC0) {
            i += (i + 2 <= n) ? 2 : (n - i);
            currentU16 += 1;
        } else if ((c & 0xF0) == 0xE0) {
            i += (i + 3 <= n) ? 3 : (n - i);
            currentU16 += 1;
        } else if ((c & 0xF8) == 0xF0) {
            if (currentU16 + 2 > utf16Col) break; // Do not split surrogate pair
            i += (i + 4 <= n) ? 4 : (n - i);
            currentU16 += 2;
        } else {
            i += 1;
            currentU16 += 1;
        }
    }
    return i;
}

inline size_t utf16ColumnToByteOffset(const std::string& str, size_t utf16Col) {
    return utf16ColumnToByteOffsetSlice(str.data(), str.size(), utf16Col);
}

inline size_t byteOffsetToUtf16ColumnSlice(const char* data, size_t n, size_t byteOffset) {
    byteOffset = std::min(byteOffset, n);
    size_t currentU16 = 0;
    size_t i = 0;
    while (i < byteOffset) {
        unsigned char c = static_cast<unsigned char>(data[i]);
        if (c < 0x80) {
            i += 1;
            currentU16 += 1;
        } else if ((c & 0xE0) == 0xC0) {
            i += 2;
            currentU16 += 1;
        } else if ((c & 0xF0) == 0xE0) {
            i += 3;
            currentU16 += 1;
        } else if ((c & 0xF8) == 0xF0) {
            i += 4;
            currentU16 += 2;
        } else {
            i += 1;
            currentU16 += 1;
        }
    }
    return currentU16;
}

inline size_t byteOffsetToUtf16Column(const std::string& str, size_t byteOffset) {
    return byteOffsetToUtf16ColumnSlice(str.data(), str.size(), byteOffset);
}

} // namespace utf8_util

// ─── Red-Black Piece Tree Data Structure (O(log P) Text Buffer) ───────────────

enum class BufferType : uint8_t { ORIGINAL = 0, ADD = 1 };

struct BufferCursor {
    uint32_t line; // 0-based index into TextBuffer::lineStarts
    uint32_t col;  // byte offset from lineStarts[line]
};

struct Piece {
    BufferType buffer = BufferType::ORIGINAL;
    BufferCursor start{0, 0};
    BufferCursor end{0, 0};
    uint32_t length = 0;      // UTF-8 byte length
    uint32_t utf16Length = 0; // UTF-16 code unit length
    uint32_t lfCount = 0;     // Number of '\n' characters in this piece
};

struct TextBuffer {
    std::string buffer;
    std::vector<uint32_t> lineStarts; // Byte offsets of each line start (always begins with 0)

    TextBuffer() {
        lineStarts.push_back(0);
    }

    explicit TextBuffer(std::string text) : buffer(std::move(text)) {
        rebuildLineStarts();
    }

    void clear() {
        buffer.clear();
        lineStarts.clear();
        lineStarts.push_back(0);
    }

    void rebuildLineStarts() {
        lineStarts.clear();
        lineStarts.push_back(0);
        const char* data = buffer.data();
        size_t n = buffer.size();
        size_t pos = 0;
        while (pos < n) {
            const void* nl = std::memchr(data + pos, '\n', n - pos);
            if (!nl) break;
            size_t idx = static_cast<const char*>(nl) - data;
            lineStarts.push_back(static_cast<uint32_t>(idx + 1));
            pos = idx + 1;
        }
    }

    uint32_t byteOffset(const BufferCursor& c) const {
        return lineStarts[c.line] + c.col;
    }

    BufferCursor cursorAtByteOffset(uint32_t offset) const {
        auto it = std::upper_bound(lineStarts.begin(), lineStarts.end(), offset);
        uint32_t line = static_cast<uint32_t>((it - lineStarts.begin()) - 1);
        return BufferCursor{line, offset - lineStarts[line]};
    }
};

/**
 * PieceTable backed by an intrusive Pool-Allocated Red-Black Piece Tree.
 *
 * Guarantees O(log P) insertions, deletions, line-to-offset lookups,
 * offset-to-line lookups, and Tree-sitter chunk streaming with zero
 * full-document scans or vector shifts.
 */
class PieceTable {
private:
    enum class Color : uint8_t { RED = 0, BLACK = 1 };

    struct Node {
        Piece piece;
        uint32_t left = 0;
        uint32_t right = 0;
        uint32_t parent = 0;
        Color color = Color::BLACK;
        uint32_t sizeLeft = 0;  // Sum of UTF-8 bytes in left subtree
        uint32_t utf16Left = 0; // Sum of UTF-16 units in left subtree
        uint32_t lfLeft = 0;    // Sum of '\n' count in left subtree
    };

    TextBuffer original_;
    TextBuffer add_;
    std::vector<Node> nodes_; // Index 0 is the NIL sentinel node
    std::vector<uint32_t> freeList_;
    uint32_t root_ = 0;
    size_t totalLength_ = 0;
    size_t totalUtf16Length_ = 0;
    size_t totalLfCount_ = 0;

    // 1-element cache for sequential Tree-sitter readCallback streaming
    mutable uint32_t cachedNode_ = 0;
    mutable size_t cachedNodeStart_ = 0;

    // Lazy lineStarts mirror only populated if getLineStartOffsets() is called directly
    mutable bool lineOffsetsMirrorDirty_ = true;
    mutable std::vector<size_t> lineStartOffsetsMirror_;

    const TextBuffer& getBuf(BufferType type) const {
        return (type == BufferType::ORIGINAL) ? original_ : add_;
    }

    uint32_t allocNode(const Piece& p) {
        uint32_t idx;
        if (!freeList_.empty()) {
            idx = freeList_.back();
            freeList_.pop_back();
        } else {
            idx = static_cast<uint32_t>(nodes_.size());
            if (nodes_.size() == nodes_.capacity()) { nodes_.reserve(std::max<size_t>(256, nodes_.capacity() * 2)); } nodes_.emplace_back();
        }
        nodes_[idx] = Node{p, 0, 0, 0, Color::RED, 0, 0, 0};
        return idx;
    }

    void freeNode(uint32_t idx) {
        if (idx == 0) return;
        if (cachedNode_ == idx) cachedNode_ = 0;
        freeList_.push_back(idx);
    }

    void invalidateCachedNode() const {
        cachedNode_ = 0;
        lineOffsetsMirrorDirty_ = true;
    }

    Piece makePieceFromBytes(BufferType bufType, uint32_t startByte, uint32_t endByte) const {
        const TextBuffer& tb = getBuf(bufType);
        BufferCursor s = tb.cursorAtByteOffset(startByte);
        BufferCursor e = tb.cursorAtByteOffset(endByte);
        uint32_t len = endByte - startByte;
        uint32_t u16 = static_cast<uint32_t>(utf8_util::utf16LengthSlice(tb.buffer.data() + startByte, len));
        uint32_t lf = e.line - s.line;
        return Piece{bufType, s, e, len, u16, lf};
    }

    // Update sizeLeft, utf16Left, lfLeft along ancestors when a node's subtree changes by delta
    void updateMetadataUpwards(uint32_t x, int64_t dBytes, int64_t dUtf16, int64_t dLf) {
        if (dBytes == 0 && dUtf16 == 0 && dLf == 0) return;
        uint32_t cur = x;
        while (cur != root_ && cur != 0) {
            uint32_t p = nodes_[cur].parent;
            if (p != 0 && nodes_[p].left == cur) {
                nodes_[p].sizeLeft = static_cast<uint32_t>(static_cast<int64_t>(nodes_[p].sizeLeft) + dBytes);
                nodes_[p].utf16Left = static_cast<uint32_t>(static_cast<int64_t>(nodes_[p].utf16Left) + dUtf16);
                nodes_[p].lfLeft = static_cast<uint32_t>(static_cast<int64_t>(nodes_[p].lfLeft) + dLf);
            }
            cur = p;
        }
    }

    void resetSentinel() {
        nodes_[0].parent = 0;
        nodes_[0].left = 0;
        nodes_[0].right = 0;
        nodes_[0].color = Color::BLACK;
        nodes_[0].sizeLeft = 0;
        nodes_[0].utf16Left = 0;
        nodes_[0].lfLeft = 0;
    }

    void leftRotate(uint32_t x) {
        if (x == 0) return;
        uint32_t y = nodes_[x].right;
        if (y == 0) return;

        nodes_[y].sizeLeft += nodes_[x].sizeLeft + nodes_[x].piece.length;
        nodes_[y].utf16Left += nodes_[x].utf16Left + nodes_[x].piece.utf16Length;
        nodes_[y].lfLeft += nodes_[x].lfLeft + nodes_[x].piece.lfCount;

        nodes_[x].right = nodes_[y].left;
        if (nodes_[y].left != 0) {
            nodes_[nodes_[y].left].parent = x;
        }
        nodes_[y].parent = nodes_[x].parent;
        if (nodes_[x].parent == 0) {
            root_ = y;
        } else if (nodes_[nodes_[x].parent].left == x) {
            nodes_[nodes_[x].parent].left = y;
        } else {
            nodes_[nodes_[x].parent].right = y;
        }
        nodes_[y].left = x;
        nodes_[x].parent = y;
        resetSentinel();
    }

    void rightRotate(uint32_t y) {
        if (y == 0) return;
        uint32_t x = nodes_[y].left;
        if (x == 0) return;

        nodes_[y].sizeLeft -= (nodes_[x].sizeLeft + nodes_[x].piece.length);
        nodes_[y].utf16Left -= (nodes_[x].utf16Left + nodes_[x].piece.utf16Length);
        nodes_[y].lfLeft -= (nodes_[x].lfLeft + nodes_[x].piece.lfCount);

        nodes_[y].left = nodes_[x].right;
        if (nodes_[x].right != 0) {
            nodes_[nodes_[x].right].parent = y;
        }
        nodes_[x].parent = nodes_[y].parent;
        if (nodes_[y].parent == 0) {
            root_ = x;
        } else if (nodes_[nodes_[y].parent].right == y) {
            nodes_[nodes_[y].parent].right = x;
        } else {
            nodes_[nodes_[y].parent].left = x;
        }
        nodes_[x].right = y;
        nodes_[y].parent = x;
        resetSentinel();
    }

    void fixInsert(uint32_t z) {
        while (z != root_ && nodes_[nodes_[z].parent].color == Color::RED) {
            uint32_t p = nodes_[z].parent;
            uint32_t g = nodes_[p].parent;
            if (p == nodes_[g].left) {
                uint32_t y = nodes_[g].right;
                if (y != 0 && nodes_[y].color == Color::RED) {
                    nodes_[p].color = Color::BLACK;
                    nodes_[y].color = Color::BLACK;
                    nodes_[g].color = Color::RED;
                    z = g;
                } else {
                    if (z == nodes_[p].right) {
                        z = p;
                        leftRotate(z);
                        p = nodes_[z].parent;
                        g = nodes_[p].parent;
                    }
                    nodes_[p].color = Color::BLACK;
                    nodes_[g].color = Color::RED;
                    rightRotate(g);
                }
            } else {
                uint32_t y = nodes_[g].left;
                if (y != 0 && nodes_[y].color == Color::RED) {
                    nodes_[p].color = Color::BLACK;
                    nodes_[y].color = Color::BLACK;
                    nodes_[g].color = Color::RED;
                    z = g;
                } else {
                    if (z == nodes_[p].left) {
                        z = p;
                        rightRotate(z);
                        p = nodes_[z].parent;
                        g = nodes_[p].parent;
                    }
                    nodes_[p].color = Color::BLACK;
                    nodes_[g].color = Color::RED;
                    leftRotate(g);
                }
            }
        }
        nodes_[root_].color = Color::BLACK;
        nodes_[0].color = Color::BLACK;
    }

    uint32_t insertLeftmost(uint32_t subRoot, const Piece& p) {
        uint32_t z = allocNode(p);
        if (root_ == 0) {
            root_ = z;
            nodes_[z].color = Color::BLACK;
            return z;
        }
        uint32_t cur = subRoot;
        while (nodes_[cur].left != 0) {
            cur = nodes_[cur].left;
        }
        nodes_[cur].left = z;
        nodes_[z].parent = cur;
        updateMetadataUpwards(z, p.length, p.utf16Length, p.lfCount);
        fixInsert(z);
        return z;
    }

    uint32_t insertBefore(uint32_t target, const Piece& p) {
        if (target == 0) return insertRightmost(root_, p);
        uint32_t z = allocNode(p);
        if (nodes_[target].left == 0) {
            nodes_[target].left = z;
            nodes_[z].parent = target;
        } else {
            uint32_t cur = nodes_[target].left;
            while (nodes_[cur].right != 0) {
                cur = nodes_[cur].right;
            }
            nodes_[cur].right = z;
            nodes_[z].parent = cur;
        }
        updateMetadataUpwards(z, p.length, p.utf16Length, p.lfCount);
        fixInsert(z);
        return z;
    }

    uint32_t insertAfter(uint32_t target, const Piece& p) {
        if (target == 0) return insertLeftmost(root_, p);
        uint32_t z = allocNode(p);
        if (nodes_[target].right == 0) {
            nodes_[target].right = z;
            nodes_[z].parent = target;
        } else {
            uint32_t cur = nodes_[target].right;
            while (nodes_[cur].left != 0) {
                cur = nodes_[cur].left;
            }
            nodes_[cur].left = z;
            nodes_[z].parent = cur;
        }
        updateMetadataUpwards(z, p.length, p.utf16Length, p.lfCount);
        fixInsert(z);
        return z;
    }

    uint32_t insertRightmost(uint32_t subRoot, const Piece& p) {
        uint32_t z = allocNode(p);
        if (root_ == 0) {
            root_ = z;
            nodes_[z].color = Color::BLACK;
            return z;
        }
        uint32_t cur = subRoot;
        while (nodes_[cur].right != 0) {
            cur = nodes_[cur].right;
        }
        nodes_[cur].right = z;
        nodes_[z].parent = cur;
        updateMetadataUpwards(z, p.length, p.utf16Length, p.lfCount);
        fixInsert(z);
        return z;
    }

    uint32_t prevNode(uint32_t x) const {
        if (x == 0) return 0;
        if (nodes_[x].left != 0) {
            uint32_t cur = nodes_[x].left;
            while (nodes_[cur].right != 0) cur = nodes_[cur].right;
            return cur;
        }
        uint32_t cur = x;
        uint32_t p = nodes_[cur].parent;
        while (p != 0 && cur == nodes_[p].left) {
            cur = p;
            p = nodes_[p].parent;
        }
        return p;
    }

    uint32_t nextNode(uint32_t x) const {
        if (x == 0) return 0;
        if (nodes_[x].right != 0) {
            uint32_t cur = nodes_[x].right;
            while (nodes_[cur].left != 0) cur = nodes_[cur].left;
            return cur;
        }
        uint32_t cur = x;
        uint32_t p = nodes_[cur].parent;
        while (p != 0 && cur == nodes_[p].right) {
            cur = p;
            p = nodes_[p].parent;
        }
        return p;
    }

    void rbTransplant(uint32_t u, uint32_t v) {
        if (nodes_[u].parent == 0) {
            root_ = v;
        } else if (u == nodes_[nodes_[u].parent].left) {
            nodes_[nodes_[u].parent].left = v;
        } else {
            nodes_[nodes_[u].parent].right = v;
        }
        if (v != 0) {
            nodes_[v].parent = nodes_[u].parent;
        }
    }

    void fixDelete(uint32_t x) {
        while (x != root_ && nodes_[x].color == Color::BLACK) {
            uint32_t p = nodes_[x].parent;
            if (p == 0) break;
            if (x == nodes_[p].left) {
                uint32_t w = nodes_[p].right;
                if (w != 0 && nodes_[w].color == Color::RED) {
                    nodes_[w].color = Color::BLACK;
                    nodes_[p].color = Color::RED;
                    leftRotate(p);
                    w = nodes_[p].right;
                }
                if (w == 0) {
                    x = p;
                } else if (nodes_[nodes_[w].left].color == Color::BLACK &&
                           nodes_[nodes_[w].right].color == Color::BLACK) {
                    nodes_[w].color = Color::RED;
                    x = p;
                } else {
                    if (nodes_[nodes_[w].right].color == Color::BLACK) {
                        nodes_[nodes_[w].left].color = Color::BLACK;
                        nodes_[w].color = Color::RED;
                        rightRotate(w);
                        w = nodes_[p].right;
                    }
                    nodes_[w].color = nodes_[p].color;
                    nodes_[p].color = Color::BLACK;
                    nodes_[nodes_[w].right].color = Color::BLACK;
                    leftRotate(p);
                    x = root_;
                }
            } else {
                uint32_t w = nodes_[p].left;
                if (w != 0 && nodes_[w].color == Color::RED) {
                    nodes_[w].color = Color::BLACK;
                    nodes_[p].color = Color::RED;
                    rightRotate(p);
                    w = nodes_[p].left;
                }
                if (w == 0) {
                    x = p;
                } else if (nodes_[nodes_[w].right].color == Color::BLACK &&
                           nodes_[nodes_[w].left].color == Color::BLACK) {
                    nodes_[w].color = Color::RED;
                    x = p;
                } else {
                    if (nodes_[nodes_[w].left].color == Color::BLACK) {
                        nodes_[nodes_[w].right].color = Color::BLACK;
                        nodes_[w].color = Color::RED;
                        leftRotate(w);
                        w = nodes_[p].left;
                    }
                    nodes_[w].color = nodes_[p].color;
                    nodes_[p].color = Color::BLACK;
                    nodes_[nodes_[w].left].color = Color::BLACK;
                    rightRotate(p);
                    x = root_;
                }
            }
        }
        nodes_[x].color = Color::BLACK;
        nodes_[0].color = Color::BLACK;
        nodes_[0].parent = 0;
        nodes_[0].left = 0;
        nodes_[0].right = 0;
    }

    void deleteNode(uint32_t z) {
        if (z == 0) return;

        // If z has two children, swap its Piece with its in-order successor y
        // and delete y instead (y is guaranteed to have at most one child: y.right).
        if (nodes_[z].left != 0 && nodes_[z].right != 0) {
            uint32_t y = nodes_[z].right;
            while (nodes_[y].left != 0) {
                y = nodes_[y].left;
            }
            Piece yPiece = nodes_[y].piece;
            // First remove y (which has no left child)
            deleteNode(y);
            // Then replace z's piece in-place with yPiece
            replaceNodePiece(z, yPiece);
            return;
        }

        uint32_t x = (nodes_[z].left != 0) ? nodes_[z].left : nodes_[z].right;
        uint32_t xParent = nodes_[z].parent;
        Color zOrigColor = nodes_[z].color;

        updateMetadataUpwards(z,
            -static_cast<int64_t>(nodes_[z].piece.length),
            -static_cast<int64_t>(nodes_[z].piece.utf16Length),
            -static_cast<int64_t>(nodes_[z].piece.lfCount));

        if (nodes_[z].parent == 0) {
            root_ = x;
        } else if (z == nodes_[nodes_[z].parent].left) {
            nodes_[nodes_[z].parent].left = x;
        } else {
            nodes_[nodes_[z].parent].right = x;
        }
        nodes_[x].parent = xParent;

        freeNode(z);
        if (zOrigColor == Color::BLACK) {
            fixDelete(x);
        }
        resetSentinel();
    }

    void replaceNodePiece(uint32_t x, const Piece& newPiece) {
        int64_t dBytes = static_cast<int64_t>(newPiece.length) - static_cast<int64_t>(nodes_[x].piece.length);
        int64_t dUtf16 = static_cast<int64_t>(newPiece.utf16Length) - static_cast<int64_t>(nodes_[x].piece.utf16Length);
        int64_t dLf = static_cast<int64_t>(newPiece.lfCount) - static_cast<int64_t>(nodes_[x].piece.lfCount);
        nodes_[x].piece = newPiece;
        updateMetadataUpwards(x, dBytes, dUtf16, dLf);
    }

    struct NodeHit {
        uint32_t node = 0;
        size_t nodeStartOffset = 0;
        size_t remainder = 0;
    };

    // O(log P) lookup of node containing byte offset
    NodeHit nodeAtByteOffset(size_t offset) const {
        if (root_ == 0) return {0, 0, 0};
        if (cachedNode_ != 0) {
            const Piece& cp = nodes_[cachedNode_].piece;
            if (offset >= cachedNodeStart_ && offset < cachedNodeStart_ + cp.length) {
                return {cachedNode_, cachedNodeStart_, offset - cachedNodeStart_};
            }
        }
        uint32_t x = root_;
        size_t nodeStart = 0;
        size_t rem = offset;
        while (x != 0) {
            if (rem < nodes_[x].sizeLeft) {
                x = nodes_[x].left;
            } else if (rem < nodes_[x].sizeLeft + nodes_[x].piece.length) {
                size_t start = nodeStart + nodes_[x].sizeLeft;
                size_t inNode = rem - nodes_[x].sizeLeft;
                cachedNode_ = x;
                cachedNodeStart_ = start;
                return {x, start, inNode};
            } else {
                rem -= (nodes_[x].sizeLeft + nodes_[x].piece.length);
                nodeStart += (nodes_[x].sizeLeft + nodes_[x].piece.length);
                x = nodes_[x].right;
            }
        }
        return {0, totalLength_, 0};
    }

    char charAt(size_t offset) const {
        if (offset >= totalLength_) return '\0';
        NodeHit hit = nodeAtByteOffset(offset);
        if (hit.node == 0) return '\0';
        const Piece& p = nodes_[hit.node].piece;
        const TextBuffer& tb = getBuf(p.buffer);
        uint32_t startByte = tb.byteOffset(p.start);
        return tb.buffer[startByte + hit.remainder];
    }

    // Compute byte offset of the start of 0-based line `lineIndex` in O(log P)
    size_t computeLineStartByteOffset(size_t lineIndex) const {
        if (lineIndex == 0 || root_ == 0) return 0;
        if (lineIndex > totalLfCount_) return totalLength_;

        uint32_t x = root_;
        size_t accumulatedBytes = 0;
        size_t remainingLf = lineIndex;

        while (x != 0) {
            if (nodes_[x].lfLeft >= remainingLf) {
                x = nodes_[x].left;
            } else if (nodes_[x].lfLeft + nodes_[x].piece.lfCount >= remainingLf) {
                remainingLf -= nodes_[x].lfLeft;
                accumulatedBytes += nodes_[x].sizeLeft;
                const Piece& p = nodes_[x].piece;
                const TextBuffer& tb = getBuf(p.buffer);
                uint32_t pieceStartByte = tb.byteOffset(p.start);
                uint32_t targetLineInBuf = p.start.line + static_cast<uint32_t>(remainingLf);
                uint32_t targetByteInBuf = tb.lineStarts[targetLineInBuf];
                return accumulatedBytes + (targetByteInBuf - pieceStartByte);
            } else {
                remainingLf -= (nodes_[x].lfLeft + nodes_[x].piece.lfCount);
                accumulatedBytes += nodes_[x].sizeLeft + nodes_[x].piece.length;
                x = nodes_[x].right;
            }
        }
        return totalLength_;
    }

    // Compute 0-based line index and lineStartByteOffset for a document byte offset in O(log P)
    std::pair<size_t, size_t> computeLineAndStartForOffset(size_t offset) const {
        offset = std::min(offset, totalLength_);
        if (root_ == 0 || offset == 0) return {0, 0};

        uint32_t x = root_;
        size_t accumLf = 0;
        size_t remOffset = offset;

        while (x != 0) {
            if (remOffset < nodes_[x].sizeLeft) {
                x = nodes_[x].left;
            } else if (remOffset < nodes_[x].sizeLeft + nodes_[x].piece.length ||
                       (remOffset == nodes_[x].sizeLeft + nodes_[x].piece.length && nodes_[x].right == 0)) {
                size_t inPiece = remOffset - nodes_[x].sizeLeft;
                accumLf += nodes_[x].lfLeft;
                const Piece& p = nodes_[x].piece;
                if (inPiece == 0) {
                    size_t lineIdx = accumLf;
                    return {lineIdx, computeLineStartByteOffset(lineIdx)};
                }
                const TextBuffer& tb = getBuf(p.buffer);
                uint32_t pieceStartByte = tb.byteOffset(p.start);
                BufferCursor c = tb.cursorAtByteOffset(pieceStartByte + static_cast<uint32_t>(inPiece));
                uint32_t lfInPieceBefore = c.line - p.start.line;
                size_t lineIdx = accumLf + lfInPieceBefore;
                if (lfInPieceBefore > 0) {
                    size_t nodeDocStart = offset - inPiece;
                    size_t lineStartInDoc = nodeDocStart + (tb.lineStarts[c.line] - pieceStartByte);
                    return {lineIdx, lineStartInDoc};
                }
                return {lineIdx, computeLineStartByteOffset(lineIdx)};
            } else {
                remOffset -= (nodes_[x].sizeLeft + nodes_[x].piece.length);
                accumLf += (nodes_[x].lfLeft + nodes_[x].piece.lfCount);
                x = nodes_[x].right;
            }
        }
        return {totalLfCount_, computeLineStartByteOffset(totalLfCount_)};
    }

public:
    PieceTable() {
        if (nodes_.size() == nodes_.capacity()) { nodes_.reserve(std::max<size_t>(256, nodes_.capacity() * 2)); } nodes_.emplace_back(); // Sentinel index 0
    }

    explicit PieceTable(const std::string& content) {
        if (nodes_.size() == nodes_.capacity()) { nodes_.reserve(std::max<size_t>(256, nodes_.capacity() * 2)); } nodes_.emplace_back();
        loadContent(content);
    }

    void loadContent(const std::string& content) {
        original_ = TextBuffer(content);
        add_.clear();
        nodes_.clear();
        if (nodes_.size() == nodes_.capacity()) { nodes_.reserve(std::max<size_t>(256, nodes_.capacity() * 2)); } nodes_.emplace_back(); // Sentinel index 0
        freeList_.clear();
        root_ = 0;
        totalLength_ = content.size();
        totalUtf16Length_ = 0;
        totalLfCount_ = 0;
        invalidateCachedNode();

        if (!content.empty()) {
            Piece p = makePieceFromBytes(BufferType::ORIGINAL, 0, static_cast<uint32_t>(content.size()));
            totalUtf16Length_ = p.utf16Length;
            totalLfCount_ = p.lfCount;
            insertRightmost(0, p);
        }
    }

    std::string getText() const {
        return getRange(0, totalLength_);
    }

    std::pair<const char*, uint32_t> getChunkAtOffset(size_t offset) const {
        if (offset >= totalLength_ || root_ == 0) return {nullptr, 0};
        NodeHit hit = nodeAtByteOffset(offset);
        if (hit.node == 0) return {nullptr, 0};
        const Piece& p = nodes_[hit.node].piece;
        const TextBuffer& tb = getBuf(p.buffer);
        uint32_t startByte = tb.byteOffset(p.start) + static_cast<uint32_t>(hit.remainder);
        uint32_t chunkLen = p.length - static_cast<uint32_t>(hit.remainder);
        return {tb.buffer.data() + startByte, chunkLen};
    }

    size_t length() const {
        return totalLength_;
    }

    size_t utf16Length() const {
        return totalUtf16Length_;
    }

    size_t lineCount() const {
        return totalLfCount_ + 1;
    }

    const std::vector<size_t>& getLineStartOffsets() const {
        if (lineOffsetsMirrorDirty_) {
            lineStartOffsetsMirror_.clear();
            size_t lc = lineCount();
            lineStartOffsetsMirror_.reserve(lc);
            for (size_t i = 0; i < lc; ++i) {
                lineStartOffsetsMirror_.push_back(computeLineStartByteOffset(i));
            }
            lineOffsetsMirrorDirty_ = false;
        }
        return lineStartOffsetsMirror_;
    }

    /**
     * Append text to addBuffer_ and incrementally record only its new line starts.
     */
    Piece appendToAddBuffer(const std::string& text) {
        uint32_t startByte = static_cast<uint32_t>(add_.buffer.size());
        BufferCursor startCur = add_.cursorAtByteOffset(startByte);
        if (add_.buffer.size() + text.size() > add_.buffer.capacity()) { add_.buffer.reserve(std::max<size_t>(65536, (add_.buffer.capacity() + text.size()) * 2)); } add_.buffer.append(text);
        uint32_t endByte = static_cast<uint32_t>(add_.buffer.size());

        const char* data = add_.buffer.data();
        size_t pos = startByte;
        uint32_t lf = 0;
        while (pos < endByte) {
            const void* nl = std::memchr(data + pos, '\n', endByte - pos);
            if (!nl) break;
            size_t idx = static_cast<const char*>(nl) - data;
            add_.lineStarts.push_back(static_cast<uint32_t>(idx + 1));
            lf++;
            pos = idx + 1;
        }

        BufferCursor endCur = add_.cursorAtByteOffset(endByte);
        uint32_t len = endByte - startByte;
        uint32_t u16 = static_cast<uint32_t>(utf8_util::utf16LengthSlice(text.data(), text.size()));
        return Piece{BufferType::ADD, startCur, endCur, len, u16, lf};
    }

    void insert(size_t offset, const std::string& text) {
        if (text.empty()) return;
        offset = std::min(offset, totalLength_);
        invalidateCachedNode();

        uint32_t addStartByte = static_cast<uint32_t>(add_.buffer.size());
        Piece newPiece = appendToAddBuffer(text);
        totalLength_ += newPiece.length;
        totalUtf16Length_ += newPiece.utf16Length;
        totalLfCount_ += newPiece.lfCount;

        if (root_ == 0) {
            insertRightmost(0, newPiece);
            return;
        }

        if (offset == totalLength_ - newPiece.length) {
            // Append at end of document: coalesce with rightmost node if contiguous in addBuffer_
            uint32_t last = root_;
            while (nodes_[last].right != 0) last = nodes_[last].right;
            Piece& lp = nodes_[last].piece;
            if (lp.buffer == BufferType::ADD && add_.byteOffset(lp.end) == addStartByte) {
                Piece merged = lp;
                merged.end = newPiece.end;
                merged.length += newPiece.length;
                merged.utf16Length += newPiece.utf16Length;
                merged.lfCount += newPiece.lfCount;
                replaceNodePiece(last, merged);
            } else {
                insertAfter(last, newPiece);
            }
            return;
        }

        NodeHit hit = nodeAtByteOffset(offset);
        if (hit.remainder == 0) {
            uint32_t prev = prevNode(hit.node);
            if (prev != 0 && nodes_[prev].piece.buffer == BufferType::ADD &&
                add_.byteOffset(nodes_[prev].piece.end) == addStartByte) {
                Piece merged = nodes_[prev].piece;
                merged.end = newPiece.end;
                merged.length += newPiece.length;
                merged.utf16Length += newPiece.utf16Length;
                merged.lfCount += newPiece.lfCount;
                replaceNodePiece(prev, merged);
            } else {
                insertBefore(hit.node, newPiece);
            }
        } else {
            Piece orig = nodes_[hit.node].piece;
            const TextBuffer& tb = getBuf(orig.buffer);
            uint32_t origStartByte = tb.byteOffset(orig.start);
            uint32_t splitByte = origStartByte + static_cast<uint32_t>(hit.remainder);
            uint32_t origEndByte = tb.byteOffset(orig.end);

            Piece leftPiece = makePieceFromBytes(orig.buffer, origStartByte, splitByte);
            Piece rightPiece = makePieceFromBytes(orig.buffer, splitByte, origEndByte);

            replaceNodePiece(hit.node, leftPiece);
            uint32_t midNode = insertAfter(hit.node, newPiece);
            insertAfter(midNode, rightPiece);
        }
    }

    void remove(size_t offset, size_t count) {
        if (count == 0 || root_ == 0 || offset >= totalLength_) return;
        count = std::min(count, totalLength_ - offset);
        invalidateCachedNode();

        size_t remaining = count;
        while (remaining > 0 && root_ != 0) {
            NodeHit hit = nodeAtByteOffset(offset);
            if (hit.node == 0) break;

            Piece orig = nodes_[hit.node].piece;
            const TextBuffer& tb = getBuf(orig.buffer);
            uint32_t origStartByte = tb.byteOffset(orig.start);
            uint32_t origEndByte = tb.byteOffset(orig.end);

            size_t availInNode = orig.length - hit.remainder;
            size_t delLen = std::min(remaining, availInNode);

            if (hit.remainder == 0 && delLen == orig.length) {
                totalLength_ -= orig.length;
                totalUtf16Length_ -= orig.utf16Length;
                totalLfCount_ -= orig.lfCount;
                deleteNode(hit.node);
            } else if (hit.remainder == 0) {
                Piece rightPiece = makePieceFromBytes(
                    orig.buffer,
                    origStartByte + static_cast<uint32_t>(delLen),
                    origEndByte
                );
                totalLength_ -= (orig.length - rightPiece.length);
                totalUtf16Length_ -= (orig.utf16Length - rightPiece.utf16Length);
                totalLfCount_ -= (orig.lfCount - rightPiece.lfCount);
                replaceNodePiece(hit.node, rightPiece);
            } else if (hit.remainder + delLen == orig.length) {
                Piece leftPiece = makePieceFromBytes(
                    orig.buffer,
                    origStartByte,
                    origStartByte + static_cast<uint32_t>(hit.remainder)
                );
                totalLength_ -= (orig.length - leftPiece.length);
                totalUtf16Length_ -= (orig.utf16Length - leftPiece.utf16Length);
                totalLfCount_ -= (orig.lfCount - leftPiece.lfCount);
                replaceNodePiece(hit.node, leftPiece);
            } else {
                Piece leftPiece = makePieceFromBytes(
                    orig.buffer,
                    origStartByte,
                    origStartByte + static_cast<uint32_t>(hit.remainder)
                );
                Piece rightPiece = makePieceFromBytes(
                    orig.buffer,
                    origStartByte + static_cast<uint32_t>(hit.remainder + delLen),
                    origEndByte
                );
                size_t removedBytes = orig.length - (leftPiece.length + rightPiece.length);
                size_t removedUtf16 = orig.utf16Length - (leftPiece.utf16Length + rightPiece.utf16Length);
                size_t removedLf = orig.lfCount - (leftPiece.lfCount + rightPiece.lfCount);

                totalLength_ -= removedBytes;
                totalUtf16Length_ -= removedUtf16;
                totalLfCount_ -= removedLf;

                replaceNodePiece(hit.node, leftPiece);
                insertAfter(hit.node, rightPiece);
            }

            remaining -= delLen;
        }
    }

    std::pair<size_t, size_t> getLineByteBounds(size_t lineIndex) const {
        size_t lc = lineCount();
        if (lineIndex >= lc) return {totalLength_, totalLength_};

        size_t start = computeLineStartByteOffset(lineIndex);
        size_t end;
        if (lineIndex + 1 < lc) {
            end = computeLineStartByteOffset(lineIndex + 1);
            if (end > start) {
                end--; // Exclude '\n'
                if (end > start && charAt(end - 1) == '\r') {
                    end--;
                }
            }
        } else {
            end = totalLength_;
        }
        return {start, end};
    }

    std::string getLine(size_t lineIndex) const {
        auto [start, end] = getLineByteBounds(lineIndex);
        return getRange(start, end);
    }

    size_t getLineStartOffset(size_t lineIndex) const {
        if (lineIndex >= lineCount()) return totalLength_;
        return computeLineStartByteOffset(lineIndex);
    }

    size_t getLineUtf16Length(size_t lineIndex) const {
        auto [start, end] = getLineByteBounds(lineIndex);
        if (start >= end) return 0;

        size_t units = 0;
        size_t cur = start;
        while (cur < end) {
            auto [ptr, len] = getChunkAtOffset(cur);
            if (!ptr || len == 0) break;
            size_t take = std::min<size_t>(len, end - cur);
            units += utf8_util::utf16LengthSlice(ptr, take);
            cur += take;
        }
        return units;
    }

    /**
     * Convert UTF-16 column on `lineIndex` directly to a document byte offset without allocating a string.
     */
    size_t lineColToByteOffset(size_t lineIndex, size_t utf16Col) const {
        auto [start, end] = getLineByteBounds(lineIndex);
        if (utf16Col == 0 || start >= end) return start;

        size_t cur = start;
        size_t remU16 = utf16Col;
        while (cur < end && remU16 > 0) {
            auto [ptr, len] = getChunkAtOffset(cur);
            if (!ptr || len == 0) break;
            size_t take = std::min<size_t>(len, end - cur);
            size_t i = 0;
            while (i < take && remU16 > 0) {
                unsigned char c = static_cast<unsigned char>(ptr[i]);
                size_t charBytes = (c < 0x80) ? 1 : ((c & 0xE0) == 0xC0) ? 2 : ((c & 0xF0) == 0xE0) ? 3 : ((c & 0xF8) == 0xF0) ? 4 : 1;
                size_t u16Units = (charBytes == 4) ? 2 : 1;
                if (remU16 < u16Units) return cur + i; // Do not split surrogate pair
                if (i + charBytes <= take) {
                    i += charBytes;
                    remU16 -= u16Units;
                } else {
                    // Multi-byte UTF-8 sequence split across two pieces (rare)
                    size_t avail = std::min(charBytes, end - (cur + i));
                    cur += i + avail;
                    remU16 -= u16Units;
                    i = take;
                    break;
                }
            }
            if (i <= take) cur += i;
        }
        return std::min(cur, end);
    }

    /**
     * Convert document byte offset to {1-based line, 0-based UTF-16 column} in O(log P) without string allocation.
     */
    CursorPosition byteOffsetToPosition(size_t offset) const {
        offset = std::min(offset, totalLength_);
        if (root_ == 0 || offset == 0) return CursorPosition{1.0, 0.0};

        auto [lineIdx, lineStart] = computeLineAndStartForOffset(offset);
        auto [lineStartBound, lineEndBound] = getLineByteBounds(lineIdx);
        size_t target = std::min(offset, lineEndBound);

        size_t u16Col = 0;
        size_t cur = lineStart;
        while (cur < target) {
            auto [ptr, len] = getChunkAtOffset(cur);
            if (!ptr || len == 0) break;
            size_t take = std::min<size_t>(len, target - cur);
            u16Col += utf8_util::utf16LengthSlice(ptr, take);
            cur += take;
        }
        return CursorPosition{static_cast<double>(lineIdx + 1), static_cast<double>(u16Col)};
    }

    std::string getRange(size_t start, size_t end) const {
        if (start >= end || root_ == 0 || start >= totalLength_) return "";
        end = std::min(end, totalLength_);
        std::string result;
        result.reserve(end - start);

        NodeHit hit = nodeAtByteOffset(start);
        uint32_t curNode = hit.node;
        size_t inNodeOffset = hit.remainder;
        size_t remaining = end - start;

        while (curNode != 0 && remaining > 0) {
            const Piece& p = nodes_[curNode].piece;
            const TextBuffer& tb = getBuf(p.buffer);
            uint32_t pieceStart = tb.byteOffset(p.start) + static_cast<uint32_t>(inNodeOffset);
            size_t avail = p.length - inNodeOffset;
            size_t take = std::min(remaining, avail);
            result.append(tb.buffer, pieceStart, take);
            remaining -= take;
            inNodeOffset = 0;
            if (remaining > 0) {
                curNode = nextNode(curNode);
            }
        }
        return result;
    }

    size_t externalMemoryBytes() const {
        return original_.buffer.capacity() +
               add_.buffer.capacity() +
               (original_.lineStarts.capacity() + add_.lineStarts.capacity()) * sizeof(uint32_t) +
               nodes_.capacity() * sizeof(Node);
    }
};

// ─── Undo/Redo System (Inverse Edit Based) ───────────────────────────────────

struct UndoEdit {
    size_t byteOffset;
    std::string textBefore; // Deleted text (for undo restoration)
    std::string textAfter;  // Inserted text (for redo re-application)
    uint64_t versionBefore;
    uint64_t versionAfter;
};

struct UndoStep {
    std::vector<UndoEdit> edits;
};

class UndoManager {
private:
    std::vector<UndoStep> undoStack_;
    std::vector<UndoStep> redoStack_;
    size_t groupDepth_ = 0;
    static constexpr size_t MAX_STACK_SIZE = 1000;

public:
    void clear() {
        undoStack_.clear();
        redoStack_.clear();
        groupDepth_ = 0;
    }

    // True when `s` is exactly one UTF-8 encoded code point (1-4 bytes).
    static bool isSingleCodePoint(const std::string& s) {
        if (s.empty()) return false;
        const unsigned char c = static_cast<unsigned char>(s[0]);
        size_t len = (c < 0x80) ? 1 : ((c & 0xE0) == 0xC0) ? 2 : ((c & 0xF0) == 0xE0) ? 3 : ((c & 0xF8) == 0xF0) ? 4 : 0;
        return len != 0 && s.size() == len;
    }

    void recordEdit(size_t offset, const std::string& before, const std::string& after, uint64_t vBefore, uint64_t vAfter) {
        redoStack_.clear();

        // Typing run coalescing: merge consecutive single-character inserts into one undo step
        if (groupDepth_ == 0 && !undoStack_.empty() && undoStack_.back().edits.size() == 1) {
            auto& lastEdit = undoStack_.back().edits.front();
            if (lastEdit.textBefore.empty() && before.empty() &&
                lastEdit.textAfter.size() < 80 && isSingleCodePoint(after) &&
                after[0] != '\n' && after[0] != '\r' &&
                lastEdit.byteOffset + lastEdit.textAfter.size() == offset) {
                lastEdit.textAfter += after;
                lastEdit.versionAfter = vAfter;
                return;
            }
        }

        if (groupDepth_ > 0 && !undoStack_.empty()) {
            undoStack_.back().edits.push_back({offset, before, after, vBefore, vAfter});
        } else {
            if (undoStack_.size() >= MAX_STACK_SIZE) {
                undoStack_.erase(undoStack_.begin());
            }
            undoStack_.push_back(UndoStep{{UndoEdit{offset, before, after, vBefore, vAfter}}});
        }
    }

    bool canUndo() const { return !undoStack_.empty(); }
    bool canRedo() const { return !redoStack_.empty(); }
    size_t undoCount() const { return undoStack_.size(); }
    size_t redoCount() const { return redoStack_.size(); }

    const UndoStep* popUndo() {
        if (undoStack_.empty()) return nullptr;
        redoStack_.push_back(std::move(undoStack_.back()));
        undoStack_.pop_back();
        return &redoStack_.back();
    }

    const UndoStep* popRedo() {
        if (redoStack_.empty()) return nullptr;
        undoStack_.push_back(std::move(redoStack_.back()));
        redoStack_.pop_back();
        return &undoStack_.back();
    }

    void beginGroup() {
        groupDepth_++;
        undoStack_.push_back(UndoStep{});
    }

    void endGroup() {
        if (groupDepth_ > 0) {
            groupDepth_--;
            if (!undoStack_.empty() && undoStack_.back().edits.empty()) {
                undoStack_.pop_back();
            }
        }
    }

    bool isGrouping() const { return groupDepth_ > 0; }

    size_t memorySize() const {
        size_t bytes = sizeof(*this);
        for (const auto& step : undoStack_) {
            bytes += sizeof(UndoStep) + step.edits.capacity() * sizeof(UndoEdit);
            for (const auto& e : step.edits) {
                bytes += e.textBefore.capacity() + e.textAfter.capacity();
            }
        }
        for (const auto& step : redoStack_) {
            bytes += sizeof(UndoStep) + step.edits.capacity() * sizeof(UndoEdit);
            for (const auto& e : step.edits) {
                bytes += e.textBefore.capacity() + e.textAfter.capacity();
            }
        }
        return bytes;
    }
};

// ─── Hybrid Object Implementation ────────────────────────────────────────────

class HybridEditorEngine : public HybridEditorEngineSpec {
private:
    PieceTable pieceTable_;
    std::unique_ptr<SyntaxEngine> syntaxEngine_;
    UndoManager undoManager_;
    std::vector<std::string> internalErrors_;

    // Editor settings
    LineEnding lineEnding_ = LineEnding::LF;
    double tabSize_ = 4;
    bool insertSpaces_ = true;
    bool modified_ = false;
    size_t searchCap_ = 10000;

    // Document version tracking
    uint64_t documentVersion_ = 0;
    uint64_t savedDocumentVersion_ = 0;
    uint64_t nextVersionId_ = 0;

    // ── Helpers ───────────────────────────────────────────────────────────

    void recordEdit(size_t offset, const std::string& before, const std::string& after) {
        const uint64_t vBefore = documentVersion_;
        documentVersion_ = ++nextVersionId_;
        modified_ = (documentVersion_ != savedDocumentVersion_);
        undoManager_.recordEdit(offset, before, after, vBefore, documentVersion_);
    }

    /**
     * Convert 1-based line + 0-based UTF-16 column to a byte offset in O(log P).
     */
    size_t toOffset(double line, double column) const {
        size_t lc = pieceTable_.lineCount();
        if (lc == 0) return 0;
        size_t lineIdx = static_cast<size_t>(std::max(1.0, line)) - 1;
        lineIdx = std::min(lineIdx, lc - 1);
        size_t col = static_cast<size_t>(std::max(0.0, column));
        return pieceTable_.lineColToByteOffset(lineIdx, col);
    }

    /**
     * Convert a byte offset to {line (1-based), column (0-based UTF-16 units)} in O(log P).
     */
    CursorPosition toPosition(size_t offset) const {
        return pieceTable_.byteOffsetToPosition(offset);
    }

    std::string getLineEndingStr() const {
        return (lineEnding_ == LineEnding::CRLF) ? "\r\n" : "\n";
    }

    std::string computeHash(const std::string& content) const {
        uint64_t hash = 14695981039346656037ULL;
        for (char c : content) {
            hash ^= static_cast<unsigned char>(c);
            hash *= 1099511628211ULL;
        }
        std::ostringstream oss;
        oss << std::hex << hash;
        return oss.str();
    }

    size_t clampLine(double line) const {
        size_t lc = pieceTable_.lineCount();
        if (lc == 0) return 0;
        size_t l = static_cast<size_t>(std::max(1.0, line));
        return std::min(l, lc);
    }

    static bool isWordChar(char c) {
        unsigned char uc = static_cast<unsigned char>(c);
        return std::isalnum(uc) || uc == '_' || uc >= 0x80;
    }

    static bool isOpenBracket(char c) {
        return c == '(' || c == '[' || c == '{';
    }

    static bool isCloseBracket(char c) {
        return c == ')' || c == ']' || c == '}';
    }

    static char matchingBracket(char c) {
        switch (c) {
            case '(': return ')';
            case ')': return '(';
            case '[': return ']';
            case ']': return '[';
            case '{': return '}';
            case '}': return '{';
            default: return '\0';
        }
    }

public:
    HybridEditorEngine() : HybridObject(TAG) {
        syntaxEngine_ = std::make_unique<SyntaxEngine>(&pieceTable_);
        syntaxEngine_->parseFull();
    }

    // ─── Properties (readonly) ──────────────────────────────────────────

    double getLineCount() override {
        return static_cast<double>(pieceTable_.lineCount());
    }

    double getCharacterCount() override {
        return static_cast<double>(pieceTable_.length());
    }

    bool getModified() override {
        return modified_;
    }

    // ─── Properties (read-write) ────────────────────────────────────────

    LineEnding getLineEnding() override {
        return lineEnding_;
    }

    void setLineEnding(LineEnding value) override {
        lineEnding_ = value;
    }

    double getTabSize() override {
        return tabSize_;
    }

    void setTabSize(double value) override {
        tabSize_ = std::max(1.0, value);
    }

    bool getInsertSpaces() override {
        return insertSpaces_;
    }

    void setInsertSpaces(bool value) override {
        insertSpaces_ = value;
    }

    // ─── Document Lifecycle ─────────────────────────────────────────────

    void loadContent(const std::string& content) override {
        pieceTable_.loadContent(content);
        lineEnding_ = (content.find("\r\n") != std::string::npos) ? LineEnding::CRLF : LineEnding::LF;
        undoManager_.clear();
        documentVersion_ = 0;
        savedDocumentVersion_ = 0;
        nextVersionId_ = 0;
        modified_ = false;
        if (syntaxEngine_) syntaxEngine_->parseFull();
    }

    std::string getContent() override {
        return pieceTable_.getText();
    }

    DocumentInfo getDocumentInfo() override {
        return DocumentInfo{
            static_cast<double>(pieceTable_.lineCount()),
            static_cast<double>(pieceTable_.length()),
            lineEnding_,
            modified_
        };
    }

    void markSaved() override {
        savedDocumentVersion_ = documentVersion_;
        modified_ = false;
    }

    // ─── Text Manipulation ──────────────────────────────────────────────

    CursorPosition insertText(double line, double column, const std::string& text) override {
        if (text.empty()) {
            return clampPosition(line, column);
        }
        size_t offset = toOffset(line, column);
        CursorPosition startPos = toPosition(offset);

        recordEdit(offset, "", text);
        pieceTable_.insert(offset, text);

        size_t newOffset = offset + text.size();
        CursorPosition newPos = toPosition(newOffset);
        if (syntaxEngine_) syntaxEngine_->markDirtyEdit(offset, offset, newOffset, startPos, startPos, newPos);
        return newPos;
    }

    void deleteText(const TextRange& range) override {
        TextRange norm = range;
        if (norm.startLine > norm.endLine || (norm.startLine == norm.endLine && norm.startColumn > norm.endColumn)) {
            std::swap(norm.startLine, norm.endLine);
            std::swap(norm.startColumn, norm.endColumn);
        }
        if (norm.startLine == norm.endLine && norm.startColumn == norm.endColumn) {
            return;
        }
        size_t startOff = toOffset(norm.startLine, norm.startColumn);
        size_t endOff = toOffset(norm.endLine, norm.endColumn);
        if (endOff <= startOff) return;

        CursorPosition startPos = toPosition(startOff);
        CursorPosition oldEndPos = toPosition(endOff);
        std::string deleted = pieceTable_.getRange(startOff, endOff);

        recordEdit(startOff, deleted, "");
        pieceTable_.remove(startOff, endOff - startOff);

        CursorPosition newEndPos = toPosition(startOff);
        if (syntaxEngine_) syntaxEngine_->markDirtyEdit(startOff, endOff, startOff, startPos, oldEndPos, newEndPos);
    }

    CursorPosition replaceText(const TextRange& range, const std::string& newText) override {
        TextRange norm = range;
        if (norm.startLine > norm.endLine || (norm.startLine == norm.endLine && norm.startColumn > norm.endColumn)) {
            std::swap(norm.startLine, norm.endLine);
            std::swap(norm.startColumn, norm.endColumn);
        }
        if (norm.startLine == norm.endLine && norm.startColumn == norm.endColumn && newText.empty()) {
            return CursorPosition{norm.startLine, norm.startColumn};
        }
        size_t startOff = toOffset(norm.startLine, norm.startColumn);
        size_t endOff = toOffset(norm.endLine, norm.endColumn);
        CursorPosition startPos = toPosition(startOff);
        CursorPosition oldEndPos = toPosition(endOff);

        std::string deleted = (endOff > startOff) ? pieceTable_.getRange(startOff, endOff) : "";
        recordEdit(startOff, deleted, newText);

        if (endOff > startOff) {
            pieceTable_.remove(startOff, endOff - startOff);
        }
        if (!newText.empty()) {
            pieceTable_.insert(startOff, newText);
        }

        size_t newOffset = startOff + newText.size();
        CursorPosition newPos = toPosition(newOffset);
        if (syntaxEngine_) syntaxEngine_->markDirtyEdit(startOff, endOff, newOffset, startPos, oldEndPos, newPos);
        return newPos;
    }

    void applyEdits(const std::vector<EditOperation>& edits) override {
        if (edits.empty()) return;

        undoManager_.beginGroup();

        std::vector<EditOperation> sorted = edits;
        std::sort(sorted.begin(), sorted.end(), [](const EditOperation& a, const EditOperation& b) {
            if (a.range.startLine != b.range.startLine) return a.range.startLine > b.range.startLine;
            return a.range.startColumn > b.range.startColumn;
        });

        for (const auto& edit : sorted) {
            size_t startOff = toOffset(edit.range.startLine, edit.range.startColumn);
            size_t endOff = toOffset(edit.range.endLine, edit.range.endColumn);
            CursorPosition startPos = toPosition(startOff);
            CursorPosition oldEndPos = toPosition(endOff);

            if (endOff > startOff) {
                std::string deleted = pieceTable_.getRange(startOff, endOff);
                recordEdit(startOff, deleted, edit.text);
                pieceTable_.remove(startOff, endOff - startOff);
            } else if (!edit.text.empty()) {
                recordEdit(startOff, "", edit.text);
            }
            if (!edit.text.empty()) {
                pieceTable_.insert(startOff, edit.text);
            }
            size_t newEndOff = startOff + edit.text.size();
            CursorPosition newEndPos = toPosition(newEndOff);
            if (syntaxEngine_) {
                syntaxEngine_->applyEditOnly(startOff, endOff, newEndOff, startPos, oldEndPos, newEndPos);
            }
        }

        undoManager_.endGroup();
        // Tree-sitter will reparse lazily on next getSyntaxTokens()
    }

    // ─── Line Operations ────────────────────────────────────────────────

    std::string getLine(double lineNumber) override {
        size_t lc = pieceTable_.lineCount();
        if (lc == 0) return "";
        size_t idx = static_cast<size_t>(std::max(1.0, lineNumber)) - 1;
        if (idx >= lc) return "";
        return pieceTable_.getLine(idx);
    }

    double getLineLength(double lineNumber) override {
        size_t lc = pieceTable_.lineCount();
        if (lc == 0) return 0.0;
        size_t idx = static_cast<size_t>(std::max(1.0, lineNumber)) - 1;
        if (idx >= lc) return 0.0;
        return static_cast<double>(pieceTable_.getLineUtf16Length(idx));
    }

    LineInfo getLineInfo(double lineNumber) override {
        size_t idx = static_cast<size_t>(std::max(1.0, lineNumber)) - 1;
        std::string text = pieceTable_.getLine(idx);
        size_t startOffset = pieceTable_.getLineStartOffset(idx);
        return LineInfo{
            lineNumber,
            static_cast<double>(startOffset),
            static_cast<double>(utf8_util::utf16Length(text)),
            text
        };
    }

    std::vector<std::string> getLines(double startLine, double endLine) override {
        std::vector<std::string> result;
        size_t s = static_cast<size_t>(std::max(1.0, startLine));
        size_t e = static_cast<size_t>(std::max(1.0, endLine));
        size_t lc = pieceTable_.lineCount();
        e = std::min(e, lc);
        if (s <= e) {
            result.reserve(e - s + 1);
            for (size_t i = s; i <= e; ++i) {
                result.push_back(pieceTable_.getLine(i - 1));
            }
        }
        return result;
    }

    void insertLine(double lineNumber, const std::string& text) override {
        size_t idx = static_cast<size_t>(std::max(1.0, lineNumber)) - 1;
        size_t offset;
        std::string toInsert;
        if (idx >= pieceTable_.lineCount()) {
            offset = pieceTable_.length();
            toInsert = (offset > 0 ? getLineEndingStr() : std::string()) + text;
        } else {
            offset = pieceTable_.getLineStartOffset(idx);
            toInsert = text + getLineEndingStr();
        }
        CursorPosition startPos = toPosition(offset);

        recordEdit(offset, "", toInsert);
        pieceTable_.insert(offset, toInsert);

        size_t newOffset = offset + toInsert.size();
        CursorPosition newPos = toPosition(newOffset);
        if (syntaxEngine_) syntaxEngine_->markDirtyEdit(offset, offset, newOffset, startPos, startPos, newPos);
    }

    void deleteLine(double lineNumber) override {
        size_t idx = static_cast<size_t>(std::max(1.0, lineNumber)) - 1;
        size_t lc = pieceTable_.lineCount();
        if (idx >= lc) return;

        size_t start = pieceTable_.getLineStartOffset(idx);
        size_t end;
        if (idx + 1 < lc) {
            end = pieceTable_.getLineStartOffset(idx + 1);
        } else {
            end = pieceTable_.length();
            if (start > 0 && idx > 0) {
                auto [prevStart, prevEnd] = pieceTable_.getLineByteBounds(idx - 1);
                (void)prevStart;
                start = prevEnd;
            }
        }

        if (end > start) {
            CursorPosition startPos = toPosition(start);
            CursorPosition oldEndPos = toPosition(end);
            std::string deleted = pieceTable_.getRange(start, end);

            recordEdit(start, deleted, "");
            pieceTable_.remove(start, end - start);

            CursorPosition newEndPos = toPosition(start);
            if (syntaxEngine_) syntaxEngine_->markDirtyEdit(start, end, start, startPos, oldEndPos, newEndPos);
        }
    }

    // ─── Range & Position ───────────────────────────────────────────────

    std::string getTextInRange(const TextRange& range) override {
        TextRange norm = range;
        if (norm.startLine > norm.endLine || (norm.startLine == norm.endLine && norm.startColumn > norm.endColumn)) {
            std::swap(norm.startLine, norm.endLine);
            std::swap(norm.startColumn, norm.endColumn);
        }
        size_t startOff = toOffset(norm.startLine, norm.startColumn);
        size_t endOff = toOffset(norm.endLine, norm.endColumn);
        if (endOff <= startOff) return "";
        return pieceTable_.getRange(startOff, endOff);
    }

    double getOffsetAt(double line, double column) override {
        return static_cast<double>(toOffset(line, column));
    }

    CursorPosition getPositionAt(double offset) override {
        return toPosition(static_cast<size_t>(std::max(0.0, offset)));
    }

    TextRange getWordRangeAtPosition(double line, double column) override {
        std::string lineText = getLine(line);
        size_t col = static_cast<size_t>(std::max(0.0, column));
        size_t lineLen = utf8_util::utf16Length(lineText);

        if (col >= lineLen) {
            return TextRange{line, static_cast<double>(lineLen), line, static_cast<double>(lineLen)};
        }

        size_t byteCol = utf8_util::utf16ColumnToByteOffset(lineText, col);
        size_t wordStartByte = byteCol;
        size_t wordEndByte = byteCol;

        while (wordStartByte > 0 && isWordChar(lineText[wordStartByte - 1])) {
            wordStartByte--;
        }
        while (wordEndByte < lineText.size() && isWordChar(lineText[wordEndByte])) {
            wordEndByte++;
        }

        double startCol = static_cast<double>(utf8_util::byteOffsetToUtf16Column(lineText, wordStartByte));
        double endCol = static_cast<double>(utf8_util::byteOffsetToUtf16Column(lineText, wordEndByte));

        return TextRange{line, startCol, line, endCol};
    }

    // ─── Search ─────────────────────────────────────────────────────────

    std::vector<SearchResult> findText(
        const std::string& query,
        bool caseSensitive,
        bool wholeWord,
        bool isRegex
    ) override {
        std::vector<SearchResult> results;
        if (query.empty()) return results;

        std::string content = pieceTable_.getText();

        if (isRegex) {
            try {
                auto flags = std::regex::ECMAScript | std::regex::multiline;
                if (!caseSensitive) flags |= std::regex::icase;
                std::regex re(query, flags);

                auto begin = std::sregex_iterator(content.begin(), content.end(), re);
                auto end = std::sregex_iterator();

                for (auto it = begin; it != end; ++it) {
                    if (results.size() >= searchCap_) break;

                    size_t matchStart = static_cast<size_t>(it->position());
                    size_t matchLen = static_cast<size_t>(it->length());

                    if (wholeWord) {
                        bool leftOk = (matchStart == 0) || !isWordChar(content[matchStart - 1]);
                        bool rightOk = (matchStart + matchLen >= content.size()) ||
                                       !isWordChar(content[matchStart + matchLen]);
                        if (!leftOk || !rightOk) continue;
                    }

                    CursorPosition startPos = toPosition(matchStart);
                    CursorPosition endPos = toPosition(matchStart + matchLen);

                    results.push_back(SearchResult{
                        TextRange{startPos.line, startPos.column, endPos.line, endPos.column},
                        it->str()
                    });
                }
            } catch (...) {
            }
        } else {
            const size_t qLen = query.size();
            const size_t cLen = content.size();
            if (qLen <= cLen) {
                auto charEq = [caseSensitive](char a, char b) -> bool {
                    if (caseSensitive) return a == b;
                    return std::tolower(static_cast<unsigned char>(a)) ==
                           std::tolower(static_cast<unsigned char>(b));
                };

                size_t pos = 0;
                while (pos + qLen <= cLen) {
                    if (results.size() >= searchCap_) break;

                    bool matched = true;
                    for (size_t k = 0; k < qLen; ++k) {
                        if (!charEq(content[pos + k], query[k])) {
                            matched = false;
                            break;
                        }
                    }

                    if (!matched) {
                        pos++;
                        continue;
                    }

                    if (wholeWord) {
                        bool leftOk = (pos == 0) || !isWordChar(content[pos - 1]);
                        bool rightOk = (pos + qLen >= cLen) || !isWordChar(content[pos + qLen]);
                        if (!leftOk || !rightOk) {
                            pos++;
                            continue;
                        }
                    }

                    CursorPosition startPos = toPosition(pos);
                    CursorPosition endPos = toPosition(pos + qLen);

                    results.push_back(SearchResult{
                        TextRange{startPos.line, startPos.column, endPos.line, endPos.column},
                        content.substr(pos, qLen)
                    });

                    pos += qLen;
                }
            }
        }

        return results;
    }

    double findAndReplace(
        const std::string& query,
        const std::string& replacement,
        bool caseSensitive,
        bool wholeWord,
        bool isRegex
    ) override {
        searchCap_ = std::numeric_limits<size_t>::max();
        auto results = findText(query, caseSensitive, wholeWord, isRegex);
        searchCap_ = 10000;
        if (results.empty()) return 0;

        undoManager_.beginGroup();

        struct ByteRange {
            size_t start;
            size_t end;
        };
        std::vector<ByteRange> offsets;
        offsets.reserve(results.size());
        for (const auto& r : results) {
            size_t s = toOffset(r.range.startLine, r.range.startColumn);
            size_t e = toOffset(r.range.endLine, r.range.endColumn);
            offsets.push_back({s, e});
        }

        double count = 0;
        for (auto it = offsets.rbegin(); it != offsets.rend(); ++it) {
            CursorPosition startPos = toPosition(it->start);
            CursorPosition oldEndPos = toPosition(it->end);
            if (it->end > it->start) {
                std::string deleted = pieceTable_.getRange(it->start, it->end);
                recordEdit(it->start, deleted, replacement);
                pieceTable_.remove(it->start, it->end - it->start);
            } else if (!replacement.empty()) {
                recordEdit(it->start, "", replacement);
            }
            if (!replacement.empty()) {
                pieceTable_.insert(it->start, replacement);
            }
            size_t newEndOff = it->start + replacement.size();
            CursorPosition newEndPos = toPosition(newEndOff);
            if (syntaxEngine_) {
                syntaxEngine_->applyEditOnly(it->start, it->end, newEndOff, startPos, oldEndPos, newEndPos);
            }
            count++;
        }

        undoManager_.endGroup();
        // Tree-sitter will reparse lazily on next getSyntaxTokens()

        return count;
    }

    // ─── Undo / Redo (Inverse Edit Based, Single Reparse per Batch) ──────

    std::optional<CursorPosition> undo() override {
        const UndoStep* stepPtr = undoManager_.popUndo();
        if (!stepPtr || stepPtr->edits.empty()) return std::nullopt;
        const UndoStep& step = *stepPtr;

        for (auto it = step.edits.rbegin(); it != step.edits.rend(); ++it) {
            const auto& edit = *it;
            size_t startOff = edit.byteOffset;
            size_t oldLen = edit.textAfter.size();
            size_t newLen = edit.textBefore.size();

            CursorPosition startPos = toPosition(startOff);
            CursorPosition oldEndPos = toPosition(startOff + oldLen);

            if (oldLen > 0) {
                pieceTable_.remove(startOff, oldLen);
            }
            if (newLen > 0) {
                pieceTable_.insert(startOff, edit.textBefore);
            }

            size_t newEndOff = startOff + newLen;
            CursorPosition newEndPos = toPosition(newEndOff);
            if (syntaxEngine_) {
                syntaxEngine_->applyEditOnly(startOff, startOff + oldLen, newEndOff, startPos, oldEndPos, newEndPos);
            }
        }

        if (syntaxEngine_) {
            syntaxEngine_->reparseEditedTree();
        }

        documentVersion_ = step.edits.front().versionBefore;
        modified_ = (documentVersion_ != savedDocumentVersion_);

        const auto& lastApplied = step.edits.front();
        return toPosition(lastApplied.byteOffset + lastApplied.textBefore.size());
    }

    std::optional<CursorPosition> redo() override {
        const UndoStep* stepPtr = undoManager_.popRedo();
        if (!stepPtr || stepPtr->edits.empty()) return std::nullopt;
        const UndoStep& step = *stepPtr;

        for (const auto& edit : step.edits) {
            size_t startOff = edit.byteOffset;
            size_t oldLen = edit.textBefore.size();
            size_t newLen = edit.textAfter.size();

            CursorPosition startPos = toPosition(startOff);
            CursorPosition oldEndPos = toPosition(startOff + oldLen);

            if (oldLen > 0) {
                pieceTable_.remove(startOff, oldLen);
            }
            if (newLen > 0) {
                pieceTable_.insert(startOff, edit.textAfter);
            }

            size_t newEndOff = startOff + newLen;
            CursorPosition newEndPos = toPosition(newEndOff);
            if (syntaxEngine_) {
                syntaxEngine_->applyEditOnly(startOff, startOff + oldLen, newEndOff, startPos, oldEndPos, newEndPos);
            }
        }

        if (syntaxEngine_) {
            syntaxEngine_->reparseEditedTree();
        }

        documentVersion_ = step.edits.back().versionAfter;
        modified_ = (documentVersion_ != savedDocumentVersion_);

        const auto& lastApplied = step.edits.back();
        return toPosition(lastApplied.byteOffset + lastApplied.textAfter.size());
    }

    UndoRedoState getUndoRedoState() override {
        return UndoRedoState{
            undoManager_.canUndo(),
            undoManager_.canRedo(),
            static_cast<double>(undoManager_.undoCount()),
            static_cast<double>(undoManager_.redoCount())
        };
    }

    void beginUndoGroup() override {
        undoManager_.beginGroup();
    }

    void endUndoGroup() override {
        undoManager_.endGroup();
    }

    // ─── Indentation ────────────────────────────────────────────────────

    void indentLine(double lineNumber) override {
        size_t idx = static_cast<size_t>(std::max(1.0, lineNumber)) - 1;
        size_t offset = pieceTable_.getLineStartOffset(idx);
        std::string indent = insertSpaces_ ? std::string(static_cast<size_t>(tabSize_), ' ') : "\t";

        CursorPosition startPos = toPosition(offset);
        recordEdit(offset, "", indent);
        pieceTable_.insert(offset, indent);

        size_t newOffset = offset + indent.size();
        CursorPosition newPos = toPosition(newOffset);
        if (syntaxEngine_) syntaxEngine_->markDirtyEdit(offset, offset, newOffset, startPos, startPos, newPos);
    }

    void outdentLine(double lineNumber) override {
        size_t idx = static_cast<size_t>(std::max(1.0, lineNumber)) - 1;
        std::string line = pieceTable_.getLine(idx);
        size_t offset = pieceTable_.getLineStartOffset(idx);

        size_t toRemove = 0;
        if (!line.empty() && line[0] == '\t') {
            toRemove = 1;
        } else {
            size_t spaces = 0;
            while (spaces < line.size() && spaces < static_cast<size_t>(tabSize_) && line[spaces] == ' ') {
                spaces++;
            }
            toRemove = spaces;
        }

        if (toRemove > 0) {
            CursorPosition startPos = toPosition(offset);
            size_t endOff = offset + toRemove;
            CursorPosition oldEndPos = toPosition(endOff);
            std::string deleted = pieceTable_.getRange(offset, endOff);

            recordEdit(offset, deleted, "");
            pieceTable_.remove(offset, toRemove);

            CursorPosition newEndPos = toPosition(offset);
            if (syntaxEngine_) syntaxEngine_->markDirtyEdit(offset, endOff, offset, startPos, oldEndPos, newEndPos);
        }
    }

    void indentLines(double startLine, double endLine) override {
        size_t s = static_cast<size_t>(std::max(1.0, startLine));
        size_t e = static_cast<size_t>(std::max(1.0, endLine));
        e = std::min(e, pieceTable_.lineCount());
        if (s > e) return;
        std::string indent = insertSpaces_ ? std::string(static_cast<size_t>(tabSize_), ' ') : "\t";

        std::vector<size_t> offsets;
        offsets.reserve(e - s + 1);
        for (size_t i = s; i <= e; ++i) offsets.push_back(pieceTable_.getLineStartOffset(i - 1));

        undoManager_.beginGroup();
        for (auto it = offsets.rbegin(); it != offsets.rend(); ++it) {
            size_t off = *it;
            CursorPosition startPos = toPosition(off);
            recordEdit(off, "", indent);
            pieceTable_.insert(off, indent);
            size_t newOff = off + indent.size();
            CursorPosition newPos = toPosition(newOff);
            if (syntaxEngine_) {
                syntaxEngine_->applyEditOnly(off, off, newOff, startPos, startPos, newPos);
            }
        }
        undoManager_.endGroup();
        // Tree-sitter will reparse lazily on next getSyntaxTokens()
    }

    void outdentLines(double startLine, double endLine) override {
        size_t s = static_cast<size_t>(std::max(1.0, startLine));
        size_t e = static_cast<size_t>(std::max(1.0, endLine));
        e = std::min(e, pieceTable_.lineCount());
        if (s > e) return;

        struct Cut { size_t off; size_t len; };
        std::vector<Cut> cuts;
        for (size_t i = s; i <= e; ++i) {
            std::string line = pieceTable_.getLine(i - 1);
            size_t offset = pieceTable_.getLineStartOffset(i - 1);
            size_t toRemove = 0;
            if (!line.empty() && line[0] == '\t') {
                toRemove = 1;
            } else {
                size_t spaces = 0;
                while (spaces < line.size() && spaces < static_cast<size_t>(tabSize_) && line[spaces] == ' ') {
                    spaces++;
                }
                toRemove = spaces;
            }
            if (toRemove > 0) cuts.push_back({offset, toRemove});
        }
        if (cuts.empty()) return;

        undoManager_.beginGroup();
        for (auto it = cuts.rbegin(); it != cuts.rend(); ++it) {
            CursorPosition startPos = toPosition(it->off);
            CursorPosition oldEndPos = toPosition(it->off + it->len);
            std::string deleted = pieceTable_.getRange(it->off, it->off + it->len);
            recordEdit(it->off, deleted, "");
            pieceTable_.remove(it->off, it->len);
            CursorPosition newEndPos = toPosition(it->off);
            if (syntaxEngine_) {
                syntaxEngine_->applyEditOnly(it->off, it->off + it->len, it->off, startPos, oldEndPos, newEndPos);
            }
        }
        undoManager_.endGroup();
        // Tree-sitter will reparse lazily on next getSyntaxTokens()
    }

    // ─── Bracket Matching (Chunk-Streamed Without Whole-File Copy) ──────

    std::optional<CursorPosition> findMatchingBracket(double line, double column) override {
        size_t docLen = pieceTable_.length();
        size_t offset = toOffset(line, column);
        if (offset >= docLen) return std::nullopt;

        auto [firstPtr, firstLen] = pieceTable_.getChunkAtOffset(offset);
        if (!firstPtr || firstLen == 0) return std::nullopt;

        char ch = firstPtr[0];
        if (!isOpenBracket(ch) && !isCloseBracket(ch)) return std::nullopt;

        char match = matchingBracket(ch);
        bool forward = isOpenBracket(ch);
        int depth = 0;

        if (forward) {
            size_t cur = offset;
            while (cur < docLen) {
                auto [ptr, len] = pieceTable_.getChunkAtOffset(cur);
                if (!ptr || len == 0) break;
                for (uint32_t i = 0; i < len; ++i) {
                    char c = ptr[i];
                    if (c == ch) depth++;
                    else if (c == match) {
                        depth--;
                        if (depth == 0) {
                            return toPosition(cur + i);
                        }
                    }
                }
                cur += len;
            }
        } else {
            // Scan backwards in chunks of up to 4096 bytes
            size_t curEnd = offset + 1;
            while (curEnd > 0) {
                size_t chunkStart = (curEnd > 4096) ? (curEnd - 4096) : 0;
                std::string chunk = pieceTable_.getRange(chunkStart, curEnd);
                for (size_t i = chunk.size(); i > 0; --i) {
                    char c = chunk[i - 1];
                    if (c == ch) depth++;
                    else if (c == match) {
                        depth--;
                        if (depth == 0) {
                            return toPosition(chunkStart + (i - 1));
                        }
                    }
                }
                curEnd = chunkStart;
            }
        }

        return std::nullopt;
    }

    // ─── Utilities ──────────────────────────────────────────────────────

    CursorPosition clampPosition(double line, double column) override {
        size_t lc = pieceTable_.lineCount();
        if (lc == 0) return CursorPosition{1.0, 0.0};

        size_t l = clampLine(line);
        size_t maxCol = pieceTable_.getLineUtf16Length(l - 1);
        size_t col = static_cast<size_t>(std::max(0.0, column));
        col = std::min(col, maxCol);

        return CursorPosition{static_cast<double>(l), static_cast<double>(col)};
    }

    bool isPositionValid(double line, double column) override {
        size_t l = static_cast<size_t>(line);
        if (l < 1 || l > pieceTable_.lineCount()) return false;
        size_t col = static_cast<size_t>(column);
        return col <= pieceTable_.getLineUtf16Length(l - 1);
    }

    std::vector<SyntaxToken> getSyntaxTokens(double startLine, double endLine) override {
        if (!syntaxEngine_) return {};
        return syntaxEngine_->getSyntaxTokens(static_cast<int>(startLine), static_cast<int>(endLine));
    }

    std::string getContentHash() override {
        return computeHash(pieceTable_.getText());
    }

    std::vector<std::string> getInternalErrors() override {
        std::vector<std::string> errors = internalErrors_;
        if (syntaxEngine_) {
            const auto& syntaxErrors = syntaxEngine_->getInternalErrors();
            errors.insert(errors.end(), syntaxErrors.begin(), syntaxErrors.end());
        }
        return errors;
    }

    // ─── Memory Size ────────────────────────────────────────────────────

    size_t getExternalMemorySize() noexcept override {
        return pieceTable_.externalMemoryBytes() + sizeof(PieceTable) + undoManager_.memorySize();
    }
};

} // namespace margelo::nitro::editorengine
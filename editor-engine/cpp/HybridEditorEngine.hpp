#pragma once

#include "HybridEditorEngineSpec.hpp"
#include "SyntaxEngine.hpp"
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

namespace margelo::nitro::editorengine {

// ─── UTF-8 / UTF-16 Code Unit Conversion Utilities ────────────────────────────

namespace utf8_util {

inline size_t utf16Length(const std::string& str) {
    size_t len = 0;
    size_t i = 0;
    const size_t n = str.size();
    while (i < n) {
        unsigned char c = static_cast<unsigned char>(str[i]);
        if (c < 0x80) {
            i += 1;
            len += 1;
        } else if ((c & 0xE0) == 0xC0) {
            i += 2;
            len += 1;
        } else if ((c & 0xF0) == 0xE0) {
            i += 3;
            len += 1;
        } else if ((c & 0xF8) == 0xF0) {
            i += 4;
            len += 2; // Surrogate pair in UTF-16
        } else {
            i += 1;
            len += 1;
        }
    }
    return len;
}

inline size_t utf16ColumnToByteOffset(const std::string& str, size_t utf16Col) {
    if (utf16Col == 0) return 0;
    size_t currentU16 = 0;
    size_t i = 0;
    const size_t n = str.size();
    while (i < n && currentU16 < utf16Col) {
        unsigned char c = static_cast<unsigned char>(str[i]);
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
            i += (i + 4 <= n) ? 4 : (n - i);
            currentU16 += 2;
        } else {
            i += 1;
            currentU16 += 1;
        }
    }
    return i;
}

inline size_t byteOffsetToUtf16Column(const std::string& str, size_t byteOffset) {
    byteOffset = std::min(byteOffset, str.size());
    size_t currentU16 = 0;
    size_t i = 0;
    while (i < byteOffset) {
        unsigned char c = static_cast<unsigned char>(str[i]);
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

} // namespace utf8_util

// ─── Piece Table Data Structure ───────────────────────────────────────────────

enum class BufferType { ORIGINAL, ADD };

struct Piece {
    BufferType buffer;
    size_t start;
    size_t length;
};

/**
 * Piece Table: an efficient data structure for text editing.
 *
 * Instead of modifying the original text, insertions go into an "add buffer"
 * and the document is represented as a sequence of "pieces" that reference
 * spans in either the original or add buffer. This makes insert/delete O(pieces)
 * and keeps the original text immutable.
 */
class PieceTable {
private:
    std::string originalBuffer_;
    std::string addBuffer_;
    std::vector<Piece> pieces_;
    size_t totalLength_ = 0;

    // ── Line cache ────────────────────────────────────────────────────────
    mutable bool linesCacheDirty_ = true;
    mutable std::vector<size_t> lineStartOffsets_; // byte offsets of each line start

    void invalidateCache() const {
        linesCacheDirty_ = true;
    }

    void rebuildLineCacheIfNeeded() const {
        if (!linesCacheDirty_) return;
        lineStartOffsets_.clear();
        lineStartOffsets_.push_back(0);

        size_t offset = 0;
        for (const auto& piece : pieces_) {
            const std::string& buf = (piece.buffer == BufferType::ORIGINAL)
                                     ? originalBuffer_ : addBuffer_;
            const char* data = buf.data() + piece.start;
            size_t remaining = piece.length;

            while (remaining > 0) {
                const void* nl = std::memchr(data, '\n', remaining);
                if (!nl) {
                    offset += remaining;
                    break;
                }
                size_t found = static_cast<const char*>(nl) - data;
                offset += found + 1;
                lineStartOffsets_.push_back(offset);
                data = static_cast<const char*>(nl) + 1;
                remaining -= (found + 1);
            }
        }
        linesCacheDirty_ = false;
    }

    /**
     * Get the character at a given document offset.
     * Returns '\0' if offset is out of bounds.
     */
    char charAt(size_t offset) const {
        size_t pos = 0;
        for (const auto& piece : pieces_) {
            if (offset < pos + piece.length) {
                const std::string& buf = (piece.buffer == BufferType::ORIGINAL)
                                         ? originalBuffer_ : addBuffer_;
                return buf[piece.start + (offset - pos)];
            }
            pos += piece.length;
        }
        return '\0';
    }

    /**
     * Find which piece contains a given document offset, and where within that piece.
     * Returns the piece index and the offset within that piece.
     */
    std::pair<size_t, size_t> findPieceAtOffset(size_t offset) const {
        size_t pos = 0;
        for (size_t i = 0; i < pieces_.size(); ++i) {
            if (offset < pos + pieces_[i].length) {
                return {i, offset - pos};
            }
            pos += pieces_[i].length;
        }
        return {pieces_.size(), 0};
    }

public:
    PieceTable() = default;

    explicit PieceTable(const std::string& content) {
        originalBuffer_ = content;
        addBuffer_.clear();
        pieces_.clear();
        totalLength_ = content.size();
        if (!content.empty()) {
            pieces_.push_back({BufferType::ORIGINAL, 0, content.size()});
        }
        invalidateCache();
    }

    void loadContent(const std::string& content) {
        originalBuffer_ = content;
        addBuffer_.clear();
        pieces_.clear();
        totalLength_ = content.size();
        if (!content.empty()) {
            pieces_.push_back({BufferType::ORIGINAL, 0, content.size()});
        }
        invalidateCache();
    }

    std::string getText() const {
        std::string result;
        result.reserve(totalLength_);
        for (const auto& piece : pieces_) {
            const std::string& buf = (piece.buffer == BufferType::ORIGINAL)
                                     ? originalBuffer_ : addBuffer_;
            result.append(buf, piece.start, piece.length);
        }
        return result;
    }

    std::pair<const char*, uint32_t> getChunkAtOffset(size_t offset) const {
        size_t pos = 0;
        for (const auto& piece : pieces_) {
            if (offset < pos + piece.length) {
                const std::string& buf = (piece.buffer == BufferType::ORIGINAL)
                                         ? originalBuffer_ : addBuffer_;
                return {buf.data() + piece.start + (offset - pos), static_cast<uint32_t>(piece.length - (offset - pos))};
            }
            pos += piece.length;
        }
        return {nullptr, 0};
    }

    size_t length() const {
        return totalLength_;
    }

    size_t lineCount() const {
        rebuildLineCacheIfNeeded();
        return lineStartOffsets_.size();
    }

    const std::vector<size_t>& getLineStartOffsets() const {
        rebuildLineCacheIfNeeded();
        return lineStartOffsets_;
    }

    /**
     * Insert text at a given document byte offset.
     * Merges adjacent pieces into the addBuffer_ when contiguous (solves defect E4).
     */
    void insert(size_t offset, const std::string& text) {
        if (text.empty()) return;

        size_t addStart = addBuffer_.size();
        addBuffer_ += text;
        totalLength_ += text.size();
        Piece newPiece{BufferType::ADD, addStart, text.size()};

        if (pieces_.empty()) {
            pieces_.push_back(newPiece);
            invalidateCache();
            return;
        }

        auto [pieceIdx, innerOffset] = findPieceAtOffset(offset);

        if (pieceIdx >= pieces_.size()) {
            // Append at end: if last piece is contiguous in addBuffer_, extend it
            Piece& last = pieces_.back();
            if (last.buffer == BufferType::ADD && last.start + last.length == addStart) {
                last.length += text.size();
            } else {
                pieces_.push_back(newPiece);
            }
        } else if (innerOffset == 0) {
            // Insert before piece: check if preceding piece is contiguous
            if (pieceIdx > 0 && pieces_[pieceIdx - 1].buffer == BufferType::ADD &&
                pieces_[pieceIdx - 1].start + pieces_[pieceIdx - 1].length == addStart) {
                pieces_[pieceIdx - 1].length += text.size();
            } else {
                pieces_.insert(pieces_.begin() + static_cast<ptrdiff_t>(pieceIdx), newPiece);
            }
        } else {
            // Split the piece
            Piece& orig = pieces_[pieceIdx];
            Piece left{orig.buffer, orig.start, innerOffset};
            Piece right{orig.buffer, orig.start + innerOffset, orig.length - innerOffset};
            pieces_[pieceIdx] = left;
            pieces_.insert(pieces_.begin() + static_cast<ptrdiff_t>(pieceIdx) + 1, right);
            pieces_.insert(pieces_.begin() + static_cast<ptrdiff_t>(pieceIdx) + 1, newPiece);
        }
        invalidateCache();
    }

    /**
     * Delete `count` characters starting at `offset`.
     */
    void remove(size_t offset, size_t count) {
        if (count == 0) return;
        totalLength_ = (totalLength_ >= count) ? (totalLength_ - count) : 0;

        size_t remaining = count;
        size_t pos = 0;
        std::vector<Piece> newPieces;

        for (size_t i = 0; i < pieces_.size(); ++i) {
            const Piece& p = pieces_[i];
            size_t pieceEnd = pos + p.length;

            if (remaining == 0) {
                // Deletion complete — keep all remaining pieces
                newPieces.push_back(p);
                pos = pieceEnd;
                continue;
            }

            if (offset >= pieceEnd) {
                // This piece is entirely before the deletion range
                newPieces.push_back(p);
                pos = pieceEnd;
                continue;
            }

            if (offset <= pos && offset + remaining >= pieceEnd) {
                // Entire piece is deleted
                remaining -= p.length;
                pos = pieceEnd;
                continue;
            }

            if (offset > pos) {
                // Keep the left portion
                size_t leftLen = offset - pos;
                newPieces.push_back({p.buffer, p.start, leftLen});

                size_t deleteInPiece = std::min(remaining, p.length - leftLen);
                remaining -= deleteInPiece;

                // Keep the right portion if any
                size_t rightStart = p.start + leftLen + deleteInPiece;
                size_t rightLen = p.length - leftLen - deleteInPiece;
                if (rightLen > 0) {
                    newPieces.push_back({p.buffer, rightStart, rightLen});
                }
            } else {
                // Deletion starts at or before this piece's start
                size_t deleteInPiece = std::min(remaining, p.length);
                remaining -= deleteInPiece;

                size_t rightLen = p.length - deleteInPiece;
                if (rightLen > 0) {
                    newPieces.push_back({p.buffer, p.start + deleteInPiece, rightLen});
                }
            }
            pos = pieceEnd;
        }

        pieces_ = std::move(newPieces);
        invalidateCache();
    }

    /**
     * Get the text of a specific line (0-based internally).
     */
    std::string getLine(size_t lineIndex) const {
        rebuildLineCacheIfNeeded();
        if (lineIndex >= lineStartOffsets_.size()) return "";

        size_t start = lineStartOffsets_[lineIndex];
        size_t end;
        if (lineIndex + 1 < lineStartOffsets_.size()) {
            end = lineStartOffsets_[lineIndex + 1];
            // Exclude trailing \n (and possibly \r)
            if (end > start) {
                end--; // skip the \n
                if (end > start) {
                    char prevChar = charAt(end - 1);
                    if (prevChar == '\r') end--;
                }
            }
        } else {
            end = length();
        }

        return getRange(start, end);
    }

    /**
     * Get byte offset of the start of a line (0-based line index).
     */
    size_t getLineStartOffset(size_t lineIndex) const {
        rebuildLineCacheIfNeeded();
        if (lineIndex >= lineStartOffsets_.size()) return length();
        return lineStartOffsets_[lineIndex];
    }

    /**
     * Get a substring by byte offsets [start, end).
     */
    std::string getRange(size_t start, size_t end) const {
        if (start >= end) return "";
        size_t needed = end - start;
        std::string result;
        result.reserve(needed);

        size_t pos = 0;
        for (const auto& piece : pieces_) {
            size_t pieceEnd = pos + piece.length;
            if (pos >= end) break;
            if (pieceEnd <= start) { pos = pieceEnd; continue; }

            size_t from = (start > pos) ? (start - pos) : 0;
            size_t to = (end < pieceEnd) ? (end - pos) : piece.length;

            const std::string& buf = (piece.buffer == BufferType::ORIGINAL)
                                     ? originalBuffer_ : addBuffer_;
            result.append(buf, piece.start + from, to - from);
            pos = pieceEnd;
        }
        return result;
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

    void recordEdit(size_t offset, const std::string& before, const std::string& after, uint64_t vBefore, uint64_t vAfter) {
        redoStack_.clear();

        // Typing run coalescing: merge consecutive single-character inserts into one undo step
        if (groupDepth_ == 0 && !undoStack_.empty() && undoStack_.back().edits.size() == 1) {
            auto& lastEdit = undoStack_.back().edits.front();
            if (lastEdit.textBefore.empty() && before.empty() &&
                lastEdit.textAfter.size() < 80 && after.size() == 1 &&
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

    std::optional<UndoStep> popUndo() {
        if (undoStack_.empty()) return std::nullopt;
        UndoStep step = std::move(undoStack_.back());
        undoStack_.pop_back();
        redoStack_.push_back(step);
        return step;
    }

    std::optional<UndoStep> popRedo() {
        if (redoStack_.empty()) return std::nullopt;
        UndoStep step = std::move(redoStack_.back());
        redoStack_.pop_back();
        undoStack_.push_back(step);
        return step;
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

    // Document version tracking (O(1) modified check without hashing whole document)
    uint64_t documentVersion_ = 0;
    uint64_t savedDocumentVersion_ = 0;

    // ── Helpers ───────────────────────────────────────────────────────────

    /**
     * Record an edit operation in the undo manager and update document version.
     */
    void recordEdit(size_t offset, const std::string& before, const std::string& after) {
        documentVersion_++;
        modified_ = (documentVersion_ != savedDocumentVersion_);
        undoManager_.recordEdit(offset, before, after, documentVersion_ - 1, documentVersion_);
    }

    /**
     * Convert 1-based line + 0-based UTF-16 column to a byte offset.
     */
    size_t toOffset(double line, double column) const {
        size_t lc = pieceTable_.lineCount();
        if (lc == 0) return 0;
        size_t lineIdx = static_cast<size_t>(std::max(1.0, line)) - 1;
        lineIdx = std::min(lineIdx, lc - 1);

        size_t lineStart = pieceTable_.getLineStartOffset(lineIdx);
        std::string lineText = pieceTable_.getLine(lineIdx);
        size_t col = static_cast<size_t>(std::max(0.0, column));
        size_t byteOffsetInLine = utf8_util::utf16ColumnToByteOffset(lineText, col);
        return lineStart + byteOffsetInLine;
    }

    /**
     * Convert a byte offset to {line (1-based), column (0-based UTF-16 units)}
     * using binary search over line start offsets (solves defect E5).
     */
    CursorPosition toPosition(size_t offset) const {
        size_t docLen = pieceTable_.length();
        offset = std::min(offset, docLen);
        const auto& starts = pieceTable_.getLineStartOffsets();
        if (starts.empty() || offset == 0) {
            return CursorPosition{1.0, 0.0};
        }
        auto it = std::upper_bound(starts.begin(), starts.end(), offset);
        size_t lineIdx = (it - starts.begin()) - 1;
        size_t lineStart = starts[lineIdx];
        size_t byteOffsetInLine = offset - lineStart;
        std::string lineText = pieceTable_.getLine(lineIdx);
        double col = static_cast<double>(utf8_util::byteOffsetToUtf16Column(lineText, byteOffsetInLine));
        return CursorPosition{static_cast<double>(lineIdx + 1), col};
    }

    /**
     * Get the line ending string based on current setting.
     */
    std::string getLineEndingStr() const {
        return (lineEnding_ == LineEnding::CRLF) ? "\r\n" : "\n";
    }

    /**
     * Simple 64-bit string hash using FNV-1a algorithm for document hashing.
     */
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

    /**
     * Validate and clamp line number to valid range.
     */
    size_t clampLine(double line) const {
        size_t lc = pieceTable_.lineCount();
        if (lc == 0) return 0;
        size_t l = static_cast<size_t>(std::max(1.0, line));
        return std::min(l, lc);
    }

    /**
     * Check if a character is a word character (alphanumeric, underscore, or Unicode).
     */
    static bool isWordChar(char c) {
        unsigned char uc = static_cast<unsigned char>(c);
        return std::isalnum(uc) || uc == '_' || uc >= 0x80;
    }

    /**
     * Check if a character is an opening bracket.
     */
    static bool isOpenBracket(char c) {
        return c == '(' || c == '[' || c == '{';
    }

    /**
     * Check if a character is a closing bracket.
     */
    static bool isCloseBracket(char c) {
        return c == ')' || c == ']' || c == '}';
    }

    /**
     * Get the matching bracket character.
     */
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
        undoManager_.clear();
        documentVersion_ = 0;
        savedDocumentVersion_ = 0;
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
        if (syntaxEngine_) syntaxEngine_->applyEditAndParse(offset, offset, newOffset, startPos, startPos, newPos);
        return newPos;
    }

    void deleteText(const TextRange& range) override {
        TextRange norm = range;
        if (norm.startLine > norm.endLine || (norm.startLine == norm.endLine && norm.startColumn > norm.endColumn)) {
            std::swap(norm.startLine, norm.endLine);
            std::swap(norm.startColumn, norm.endColumn);
        }
        if (norm.startLine == norm.endLine && norm.startColumn == norm.endColumn) {
            return; // No-op, do not push undo!
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
        if (syntaxEngine_) syntaxEngine_->applyEditAndParse(startOff, endOff, startOff, startPos, oldEndPos, newEndPos);
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
        if (syntaxEngine_) syntaxEngine_->applyEditAndParse(startOff, endOff, newOffset, startPos, oldEndPos, newPos);
        return newPos;
    }

    void applyEdits(const std::vector<EditOperation>& edits) override {
        if (edits.empty()) return;

        undoManager_.beginGroup();

        // Sort edits in reverse order so earlier edits don't shift later offsets
        std::vector<EditOperation> sorted = edits;
        std::sort(sorted.begin(), sorted.end(), [](const EditOperation& a, const EditOperation& b) {
            if (a.range.startLine != b.range.startLine) return a.range.startLine > b.range.startLine;
            return a.range.startColumn > b.range.startColumn;
        });

        for (const auto& edit : sorted) {
            size_t startOff = toOffset(edit.range.startLine, edit.range.startColumn);
            size_t endOff = toOffset(edit.range.endLine, edit.range.endColumn);
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
        }

        undoManager_.endGroup();
        if (syntaxEngine_) syntaxEngine_->parseFull();
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
        std::string line = pieceTable_.getLine(idx);
        return static_cast<double>(utf8_util::utf16Length(line));
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
        for (size_t i = s; i <= e; ++i) {
            result.push_back(pieceTable_.getLine(i - 1));
        }
        return result;
    }

    void insertLine(double lineNumber, const std::string& text) override {
        size_t idx = static_cast<size_t>(std::max(1.0, lineNumber)) - 1;
        size_t offset = pieceTable_.getLineStartOffset(idx);
        std::string toInsert = text + getLineEndingStr();
        CursorPosition startPos = toPosition(offset);

        recordEdit(offset, "", toInsert);
        pieceTable_.insert(offset, toInsert);

        size_t newOffset = offset + toInsert.size();
        CursorPosition newPos = toPosition(newOffset);
        if (syntaxEngine_) syntaxEngine_->applyEditAndParse(offset, offset, newOffset, startPos, startPos, newPos);
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
                size_t prevLineStart = pieceTable_.getLineStartOffset(idx - 1);
                std::string prevLine = pieceTable_.getLine(idx - 1);
                start = prevLineStart + prevLine.size();
            }
        }

        if (end > start) {
            CursorPosition startPos = toPosition(start);
            CursorPosition oldEndPos = toPosition(end);
            std::string deleted = pieceTable_.getRange(start, end);

            recordEdit(start, deleted, "");
            pieceTable_.remove(start, end - start);

            CursorPosition newEndPos = toPosition(start);
            if (syntaxEngine_) syntaxEngine_->applyEditAndParse(start, end, start, startPos, oldEndPos, newEndPos);
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

        // Find word boundaries in UTF-16 code units
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
                auto flags = std::regex::ECMAScript;
                if (!caseSensitive) flags |= std::regex::icase;
                std::regex re(query, flags);

                auto begin = std::sregex_iterator(content.begin(), content.end(), re);
                auto end = std::sregex_iterator();

                for (auto it = begin; it != end; ++it) {
                    if (results.size() >= 10000) break; // Cap search results (defect E6)

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
                // Invalid regex, return empty
            }
        } else {
            std::string searchContent = content;
            std::string searchQuery = query;

            if (!caseSensitive) {
                std::transform(searchContent.begin(), searchContent.end(),
                               searchContent.begin(), [](unsigned char c) { return std::tolower(c); });
                std::transform(searchQuery.begin(), searchQuery.end(),
                               searchQuery.begin(), [](unsigned char c) { return std::tolower(c); });
            }

            size_t pos = 0;
            while ((pos = searchContent.find(searchQuery, pos)) != std::string::npos) {
                if (results.size() >= 10000) break; // Cap search results (defect E6)

                if (wholeWord) {
                    bool leftOk = (pos == 0) || !isWordChar(searchContent[pos - 1]);
                    bool rightOk = (pos + searchQuery.size() >= searchContent.size()) ||
                                   !isWordChar(searchContent[pos + searchQuery.size()]);
                    if (!leftOk || !rightOk) {
                        pos++;
                        continue;
                    }
                }

                CursorPosition startPos = toPosition(pos);
                CursorPosition endPos = toPosition(pos + searchQuery.size());

                results.push_back(SearchResult{
                    TextRange{startPos.line, startPos.column, endPos.line, endPos.column},
                    content.substr(pos, searchQuery.size())
                });

                pos += searchQuery.size();
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
        auto results = findText(query, caseSensitive, wholeWord, isRegex);
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
            count++;
        }

        undoManager_.endGroup();
        if (syntaxEngine_) syntaxEngine_->parseFull();

        return count;
    }

    // ─── Undo / Redo (Inverse Edit Based) ────────────────────────────────

    void undo() override {
        auto stepOpt = undoManager_.popUndo();
        if (!stepOpt.has_value()) return;
        const auto& step = stepOpt.value();

        // Apply inverse edits in reverse order
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
                syntaxEngine_->applyEditAndParse(startOff, startOff + oldLen, newEndOff, startPos, oldEndPos, newEndPos);
            }
        }

        documentVersion_ = step.edits.front().versionBefore;
        modified_ = (documentVersion_ != savedDocumentVersion_);
    }

    void redo() override {
        auto stepOpt = undoManager_.popRedo();
        if (!stepOpt.has_value()) return;
        const auto& step = stepOpt.value();

        // Apply forward edits
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
                syntaxEngine_->applyEditAndParse(startOff, startOff + oldLen, newEndOff, startPos, oldEndPos, newEndPos);
            }
        }

        documentVersion_ = step.edits.back().versionAfter;
        modified_ = (documentVersion_ != savedDocumentVersion_);
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
        if (syntaxEngine_) syntaxEngine_->applyEditAndParse(offset, offset, newOffset, startPos, startPos, newPos);
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
            if (syntaxEngine_) syntaxEngine_->applyEditAndParse(offset, endOff, offset, startPos, oldEndPos, newEndPos);
        }
    }

    void indentLines(double startLine, double endLine) override {
        size_t s = static_cast<size_t>(std::max(1.0, startLine));
        size_t e = static_cast<size_t>(std::max(1.0, endLine));
        e = std::min(e, pieceTable_.lineCount());
        std::string indent = insertSpaces_ ? std::string(static_cast<size_t>(tabSize_), ' ') : "\t";

        undoManager_.beginGroup();
        for (size_t i = e; i >= s && i > 0; --i) {
            size_t offset = pieceTable_.getLineStartOffset(i - 1);
            CursorPosition startPos = toPosition(offset);
            recordEdit(offset, "", indent);
            pieceTable_.insert(offset, indent);
            size_t newOffset = offset + indent.size();
            CursorPosition newPos = toPosition(newOffset);
            if (syntaxEngine_) syntaxEngine_->applyEditAndParse(offset, offset, newOffset, startPos, startPos, newPos);
        }
        undoManager_.endGroup();
    }

    void outdentLines(double startLine, double endLine) override {
        size_t s = static_cast<size_t>(std::max(1.0, startLine));
        size_t e = static_cast<size_t>(std::max(1.0, endLine));
        e = std::min(e, pieceTable_.lineCount());

        undoManager_.beginGroup();
        for (size_t i = e; i >= s && i > 0; --i) {
            size_t idx = i - 1;
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
                if (syntaxEngine_) syntaxEngine_->applyEditAndParse(offset, endOff, offset, startPos, oldEndPos, newEndPos);
            }
        }
        undoManager_.endGroup();
    }

    // ─── Bracket Matching ───────────────────────────────────────────────

    std::optional<CursorPosition> findMatchingBracket(double line, double column) override {
        std::string content = pieceTable_.getText();
        size_t offset = toOffset(line, column);

        if (offset >= content.size()) return std::nullopt;

        char ch = content[offset];
        if (!isOpenBracket(ch) && !isCloseBracket(ch)) return std::nullopt;

        char match = matchingBracket(ch);
        bool forward = isOpenBracket(ch);
        int depth = 0;

        if (forward) {
            for (size_t i = offset; i < content.size(); ++i) {
                if (content[i] == ch) depth++;
                else if (content[i] == match) {
                    depth--;
                    if (depth == 0) {
                        return toPosition(i);
                    }
                }
            }
        } else {
            for (size_t i = offset + 1; i > 0; --i) {
                size_t idx = i - 1;
                if (content[idx] == ch) depth++;
                else if (content[idx] == match) {
                    depth--;
                    if (depth == 0) {
                        return toPosition(idx);
                    }
                }
            }
        }

        return std::nullopt;
    }

    // ─── Utilities ──────────────────────────────────────────────────────

    CursorPosition clampPosition(double line, double column) override {
        size_t lc = pieceTable_.lineCount();
        if (lc == 0) return CursorPosition{1.0, 0.0};

        size_t l = clampLine(line);
        std::string lineText = pieceTable_.getLine(l - 1);
        size_t maxCol = utf8_util::utf16Length(lineText);
        size_t col = static_cast<size_t>(std::max(0.0, column));
        col = std::min(col, maxCol);

        return CursorPosition{static_cast<double>(l), static_cast<double>(col)};
    }

    bool isPositionValid(double line, double column) override {
        size_t l = static_cast<size_t>(line);
        if (l < 1 || l > pieceTable_.lineCount()) return false;
        size_t col = static_cast<size_t>(column);
        std::string lineText = pieceTable_.getLine(l - 1);
        return col <= utf8_util::utf16Length(lineText);
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
        return pieceTable_.length() + sizeof(PieceTable) + undoManager_.memorySize();
    }
};

} // namespace margelo::nitro::editorengine
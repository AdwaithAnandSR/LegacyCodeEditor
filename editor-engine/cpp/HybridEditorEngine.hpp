#pragma once

#include "HybridEditorEngineSpec.hpp"
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

namespace margelo::nitro::editorengine {

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
            for (size_t i = 0; i < piece.length; ++i) {
                char c = buf[piece.start + i];
                ++offset;
                if (c == '\n') {
                    lineStartOffsets_.push_back(offset);
                }
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
        if (!content.empty()) {
            pieces_.push_back({BufferType::ORIGINAL, 0, content.size()});
        }
        invalidateCache();
    }

    void loadContent(const std::string& content) {
        originalBuffer_ = content;
        addBuffer_.clear();
        pieces_.clear();
        if (!content.empty()) {
            pieces_.push_back({BufferType::ORIGINAL, 0, content.size()});
        }
        invalidateCache();
    }

    std::string getText() const {
        std::string result;
        result.reserve(length());
        for (const auto& piece : pieces_) {
            const std::string& buf = (piece.buffer == BufferType::ORIGINAL)
                                     ? originalBuffer_ : addBuffer_;
            result.append(buf, piece.start, piece.length);
        }
        return result;
    }

    size_t length() const {
        size_t total = 0;
        for (const auto& p : pieces_) total += p.length;
        return total;
    }

    size_t lineCount() const {
        rebuildLineCacheIfNeeded();
        return lineStartOffsets_.size();
    }

    /**
     * Insert text at a given document byte offset.
     */
    void insert(size_t offset, const std::string& text) {
        if (text.empty()) return;

        size_t addStart = addBuffer_.size();
        addBuffer_ += text;
        Piece newPiece{BufferType::ADD, addStart, text.size()};

        if (pieces_.empty()) {
            pieces_.push_back(newPiece);
            invalidateCache();
            return;
        }

        auto [pieceIdx, innerOffset] = findPieceAtOffset(offset);

        if (pieceIdx >= pieces_.size()) {
            // Append at end
            pieces_.push_back(newPiece);
        } else if (innerOffset == 0) {
            // Insert before piece
            pieces_.insert(pieces_.begin() + static_cast<ptrdiff_t>(pieceIdx), newPiece);
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

// ─── Undo/Redo System ────────────────────────────────────────────────────────

struct UndoAction {
    std::string contentBefore;
};

class UndoManager {
private:
    std::vector<UndoAction> undoStack_;
    std::vector<UndoAction> redoStack_;
    size_t groupDepth_ = 0;

public:
    void clear() {
        undoStack_.clear();
        redoStack_.clear();
        groupDepth_ = 0;
    }

    void pushState(const std::string& content) {
        // If we're inside a group and already have state, skip
        if (groupDepth_ > 0 && !undoStack_.empty()) return;
        undoStack_.push_back({content});
        redoStack_.clear();
    }

    bool canUndo() const { return !undoStack_.empty(); }
    bool canRedo() const { return !redoStack_.empty(); }
    size_t undoCount() const { return undoStack_.size(); }
    size_t redoCount() const { return redoStack_.size(); }

    /**
     * Undo: returns the content to restore, if available.
     */
    std::optional<std::string> undo(const std::string& currentContent) {
        if (undoStack_.empty()) return std::nullopt;
        redoStack_.push_back({currentContent});
        auto state = undoStack_.back();
        undoStack_.pop_back();
        return state.contentBefore;
    }

    /**
     * Redo: returns the content to restore, if available.
     */
    std::optional<std::string> redo(const std::string& currentContent) {
        if (redoStack_.empty()) return std::nullopt;
        undoStack_.push_back({currentContent});
        auto state = redoStack_.back();
        redoStack_.pop_back();
        return state.contentBefore;
    }

    void beginGroup() { groupDepth_++; }
    void endGroup() { if (groupDepth_ > 0) groupDepth_--; }
    bool isGrouping() const { return groupDepth_ > 0; }
};

// ─── Hybrid Object Implementation ────────────────────────────────────────────

class HybridEditorEngine : public HybridEditorEngineSpec {
private:
    PieceTable pieceTable_;
    UndoManager undoManager_;

    // Editor settings
    LineEnding lineEnding_ = LineEnding::LF;
    double tabSize_ = 4;
    bool insertSpaces_ = true;
    bool modified_ = false;
    std::string savedContentHash_;

    // ── Helpers ───────────────────────────────────────────────────────────

    /**
     * Convert 1-based line + 0-based column to a byte offset.
     */
    size_t toOffset(double line, double column) const {
        size_t lineIdx = static_cast<size_t>(std::max(1.0, line)) - 1;
        size_t col = static_cast<size_t>(std::max(0.0, column));
        size_t lineStart = pieceTable_.getLineStartOffset(lineIdx);
        return lineStart + col;
    }

    /**
     * Convert a byte offset to {line (1-based), column (0-based)}.
     */
    CursorPosition toPosition(size_t offset) const {
        size_t lc = pieceTable_.lineCount();
        for (size_t i = lc; i > 0; --i) {
            size_t lineStart = pieceTable_.getLineStartOffset(i - 1);
            if (offset >= lineStart) {
                return CursorPosition{static_cast<double>(i), static_cast<double>(offset - lineStart)};
            }
        }
        return CursorPosition{1.0, 0.0};
    }

    /**
     * Get the line ending string based on current setting.
     */
    std::string getLineEndingStr() const {
        return (lineEnding_ == LineEnding::CRLF) ? "\r\n" : "\n";
    }

    /**
     * Simple string hash using DJB2 algorithm.
     */
    std::string computeHash(const std::string& content) const {
        unsigned long hash = 5381;
        for (char c : content) {
            hash = ((hash << 5) + hash) + static_cast<unsigned char>(c);
        }
        // Convert to hex string
        std::ostringstream oss;
        oss << std::hex << hash;
        return oss.str();
    }

    /**
     * Record the current state for undo before making a change.
     */
    void recordUndo() {
        undoManager_.pushState(pieceTable_.getText());
        modified_ = true;
    }

    /**
     * Get the length of a line by its 0-based index, excluding line endings.
     */
    size_t getLineLengthInternal(size_t lineIdx) const {
        std::string line = pieceTable_.getLine(lineIdx);
        return line.size();
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
     * Check if a character is a word character (alphanumeric or underscore).
     */
    static bool isWordChar(char c) {
        return std::isalnum(static_cast<unsigned char>(c)) || c == '_';
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
    HybridEditorEngine() : HybridObject(TAG) {}

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
        modified_ = false;
        savedContentHash_ = computeHash(content);
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
        savedContentHash_ = computeHash(pieceTable_.getText());
        modified_ = false;
    }

    // ─── Text Manipulation ──────────────────────────────────────────────

    CursorPosition insertText(double line, double column, const std::string& text) override {
        recordUndo();
        size_t offset = toOffset(line, column);
        pieceTable_.insert(offset, text);
        return toPosition(offset + text.size());
    }

    void deleteText(const TextRange& range) override {
        recordUndo();
        size_t startOff = toOffset(range.startLine, range.startColumn);
        size_t endOff = toOffset(range.endLine, range.endColumn);
        if (endOff > startOff) {
            pieceTable_.remove(startOff, endOff - startOff);
        }
    }

    CursorPosition replaceText(const TextRange& range, const std::string& newText) override {
        recordUndo();
        size_t startOff = toOffset(range.startLine, range.startColumn);
        size_t endOff = toOffset(range.endLine, range.endColumn);
        if (endOff > startOff) {
            pieceTable_.remove(startOff, endOff - startOff);
        }
        pieceTable_.insert(startOff, newText);
        return toPosition(startOff + newText.size());
    }

    void applyEdits(const std::vector<EditOperation>& edits) override {
        recordUndo();

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
                pieceTable_.remove(startOff, endOff - startOff);
            }
            if (!edit.text.empty()) {
                pieceTable_.insert(startOff, edit.text);
            }
        }
    }

    // ─── Line Operations ────────────────────────────────────────────────

    std::string getLine(double lineNumber) override {
        size_t idx = static_cast<size_t>(std::max(1.0, lineNumber)) - 1;
        return pieceTable_.getLine(idx);
    }

    double getLineLength(double lineNumber) override {
        size_t idx = static_cast<size_t>(std::max(1.0, lineNumber)) - 1;
        return static_cast<double>(pieceTable_.getLine(idx).size());
    }

    LineInfo getLineInfo(double lineNumber) override {
        size_t idx = static_cast<size_t>(std::max(1.0, lineNumber)) - 1;
        std::string text = pieceTable_.getLine(idx);
        size_t startOffset = pieceTable_.getLineStartOffset(idx);
        return LineInfo{
            lineNumber,
            static_cast<double>(startOffset),
            static_cast<double>(text.size()),
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
        recordUndo();
        size_t idx = static_cast<size_t>(std::max(1.0, lineNumber)) - 1;
        size_t offset = pieceTable_.getLineStartOffset(idx);
        std::string toInsert = text + getLineEndingStr();
        pieceTable_.insert(offset, toInsert);
    }

    void deleteLine(double lineNumber) override {
        recordUndo();
        size_t idx = static_cast<size_t>(std::max(1.0, lineNumber)) - 1;
        size_t lc = pieceTable_.lineCount();
        if (idx >= lc) return;

        size_t start = pieceTable_.getLineStartOffset(idx);
        size_t end;
        if (idx + 1 < lc) {
            end = pieceTable_.getLineStartOffset(idx + 1);
        } else {
            end = pieceTable_.length();
            // If deleting last line and there's a preceding newline, remove that too
            if (start > 0 && idx > 0) {
                // Move start back to include the line ending after the previous line's text
                size_t prevLineStart = pieceTable_.getLineStartOffset(idx - 1);
                std::string prevLine = pieceTable_.getLine(idx - 1);
                start = prevLineStart + prevLine.size();
            }
        }

        if (end > start) {
            pieceTable_.remove(start, end - start);
        }
    }

    // ─── Range & Position ───────────────────────────────────────────────

    std::string getTextInRange(const TextRange& range) override {
        size_t startOff = toOffset(range.startLine, range.startColumn);
        size_t endOff = toOffset(range.endLine, range.endColumn);
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

        if (col >= lineText.size()) {
            return TextRange{line, column, line, column};
        }

        // Find word boundaries
        size_t wordStart = col;
        size_t wordEnd = col;

        while (wordStart > 0 && isWordChar(lineText[wordStart - 1])) {
            wordStart--;
        }
        while (wordEnd < lineText.size() && isWordChar(lineText[wordEnd])) {
            wordEnd++;
        }

        return TextRange{
            line, static_cast<double>(wordStart),
            line, static_cast<double>(wordEnd)
        };
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
                               searchContent.begin(), ::tolower);
                std::transform(searchQuery.begin(), searchQuery.end(),
                               searchQuery.begin(), ::tolower);
            }

            size_t pos = 0;
            while ((pos = searchContent.find(searchQuery, pos)) != std::string::npos) {
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

        recordUndo();

        // Pre-compute all byte offsets before mutating the document
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

        // Apply replacements in reverse order to preserve earlier offsets
        double count = 0;
        for (auto it = offsets.rbegin(); it != offsets.rend(); ++it) {
            if (it->end > it->start) {
                pieceTable_.remove(it->start, it->end - it->start);
            }
            if (!replacement.empty()) {
                pieceTable_.insert(it->start, replacement);
            }
            count++;
        }

        return count;
    }

    // ─── Undo / Redo ────────────────────────────────────────────────────

    void undo() override {
        auto content = undoManager_.undo(pieceTable_.getText());
        if (content.has_value()) {
            pieceTable_.loadContent(content.value());
            // Check if we're back to saved state
            if (computeHash(content.value()) == savedContentHash_) {
                modified_ = false;
            }
        }
    }

    void redo() override {
        auto content = undoManager_.redo(pieceTable_.getText());
        if (content.has_value()) {
            pieceTable_.loadContent(content.value());
            // Check if we're back to saved state
            modified_ = (computeHash(content.value()) != savedContentHash_);
        }
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
        undoManager_.pushState(pieceTable_.getText());
        undoManager_.beginGroup();
    }

    void endUndoGroup() override {
        undoManager_.endGroup();
    }

    // ─── Indentation ────────────────────────────────────────────────────

    void indentLine(double lineNumber) override {
        recordUndo();
        size_t idx = static_cast<size_t>(std::max(1.0, lineNumber)) - 1;
        size_t offset = pieceTable_.getLineStartOffset(idx);
        std::string indent;
        if (insertSpaces_) {
            indent = std::string(static_cast<size_t>(tabSize_), ' ');
        } else {
            indent = "\t";
        }
        pieceTable_.insert(offset, indent);
    }

    void outdentLine(double lineNumber) override {
        recordUndo();
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
            pieceTable_.remove(offset, toRemove);
        }
    }

    void indentLines(double startLine, double endLine) override {
        recordUndo();
        size_t s = static_cast<size_t>(std::max(1.0, startLine));
        size_t e = static_cast<size_t>(std::max(1.0, endLine));
        e = std::min(e, pieceTable_.lineCount());

        std::string indent;
        if (insertSpaces_) {
            indent = std::string(static_cast<size_t>(tabSize_), ' ');
        } else {
            indent = "\t";
        }

        // Insert from last to first to preserve offsets
        for (size_t i = e; i >= s && i > 0; --i) {
            size_t offset = pieceTable_.getLineStartOffset(i - 1);
            pieceTable_.insert(offset, indent);
        }
    }

    void outdentLines(double startLine, double endLine) override {
        recordUndo();
        size_t s = static_cast<size_t>(std::max(1.0, startLine));
        size_t e = static_cast<size_t>(std::max(1.0, endLine));
        e = std::min(e, pieceTable_.lineCount());

        // Remove from last to first to preserve offsets
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
                pieceTable_.remove(offset, toRemove);
            }
        }
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
        size_t col = static_cast<size_t>(std::max(0.0, column));
        col = std::min(col, lineText.size());

        return CursorPosition{static_cast<double>(l), static_cast<double>(col)};
    }

    bool isPositionValid(double line, double column) override {
        size_t l = static_cast<size_t>(line);
        if (l < 1 || l > pieceTable_.lineCount()) return false;
        size_t col = static_cast<size_t>(column);
        std::string lineText = pieceTable_.getLine(l - 1);
        return col <= lineText.size();
    }

    std::string getContentHash() override {
        return computeHash(pieceTable_.getText());
    }

    // ─── Memory Size ────────────────────────────────────────────────────

    size_t getExternalMemorySize() noexcept override {
        return pieceTable_.length() + sizeof(PieceTable) + sizeof(UndoManager);
    }
};

} // namespace margelo::nitro::editorengine
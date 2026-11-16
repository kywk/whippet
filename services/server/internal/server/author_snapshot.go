package server

import (
	"bytes"
	"encoding/json"
	"unicode/utf8"
)

type authorSnapshotPage struct {
	Component       string `json:"component"`
	SHA256          string `json:"sha256"`
	BaseRevision    int    `json:"baseRevision"`
	TotalBytes      int    `json:"totalBytes"`
	OffsetBytes     int    `json:"offsetBytes"`
	Content         string `json:"content"`
	NextOffsetBytes *int   `json:"nextOffsetBytes"`
}

// Callers supply the Run's immutable script_snapshot/author_payload, never Draft.
func readAuthorSnapshot(script string, input AuthorInput, raw json.RawMessage) (authorSnapshotPage, error) {
	var page authorSnapshotPage
	var fields map[string]json.RawMessage
	var args struct {
		Component   string `json:"component"`
		SHA256      string `json:"sha256"`
		OffsetBytes *int   `json:"offsetBytes"`
	}
	if (input.SkillID != "test-author" && input.SkillID != "module-authoring") || input.BaseRevision < 1 ||
		strictJSONNoDuplicates(raw) != nil || json.Unmarshal(raw, &fields) != nil || len(fields) != 3 ||
		fields["component"] == nil || fields["sha256"] == nil || fields["offsetBytes"] == nil {
		return page, ErrInvalid
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&args) != nil {
		return page, ErrInvalid
	}
	source := script
	switch args.Component {
	case "script":
	case "harness":
		if input.SkillID != "module-authoring" || input.Platform == nil || input.Platform.Module == nil {
			return page, ErrInvalid
		}
		source = input.Platform.Module.Harness
	default:
		return page, ErrInvalid
	}
	if len(source) > 2<<20 || !utf8.ValidString(source) || args.SHA256 != scriptHash(source) {
		return page, ErrInvalid
	}
	offset := 0
	if args.OffsetBytes != nil {
		offset = *args.OffsetBytes
	}
	if offset < 0 || offset > len(source) || offset < len(source) && !utf8.RuneStart(source[offset]) {
		return page, ErrInvalid
	}
	end := len(source)
	if args.OffsetBytes != nil && end-offset > 8192 {
		end = offset + 8192
	}
	for end < len(source) && !utf8.RuneStart(source[end]) {
		end--
	}
	page = authorSnapshotPage{Component: args.Component, SHA256: args.SHA256, BaseRevision: input.BaseRevision, TotalBytes: len(source), OffsetBytes: offset, Content: source[offset:end]}
	if end < len(source) {
		page.NextOffsetBytes = &end
	}
	return page, nil
}

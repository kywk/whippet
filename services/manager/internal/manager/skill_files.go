package manager

import (
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"unicode/utf8"
)

const maxSkillFilesBytes = 512 << 10

type skillFiles struct {
	Manifest   string            `json:"manifest"`
	Main       string            `json:"main"`
	References map[string]string `json:"references"`
}

type skillFileSet map[string]skillFiles

// Every entry is immutable content, never a URL or filesystem lookup. Reject
// duplicates and JSON nulls before Go's ordinary map/string decoder loses them.
func (set *skillFileSet) UnmarshalJSON(raw []byte) error {
	if len(raw) > maxSkillFilesBytes || !utf8.Valid(raw) {
		return errCapability
	}
	entries, ok := uniqueBudgetFields(raw)
	if !ok || len(entries) == 0 || len(entries) > 16 {
		return errCapability
	}
	files := make(skillFileSet, len(entries))
	for id, entry := range entries {
		fields, ok := uniqueBudgetFields(entry)
		if !ok || !capabilityID.MatchString(id) || len(fields) != 3 {
			return errCapability
		}
		var f skillFiles
		if !decodeSkillText(fields["main"], &f.Main, 8<<10) || !decodeSkillText(fields["manifest"], &f.Manifest, 64<<10) {
			return errCapability
		}
		references, ok := uniqueBudgetFields(fields["references"])
		if !ok {
			return errCapability
		}
		f.References = make(map[string]string, len(references))
		for ref, content := range references {
			var value string
			if !capabilityID.MatchString(ref) || !decodeSkillText(content, &value, 128<<10) {
				return errCapability
			}
			f.References[ref] = value
		}
		files[id] = f
	}
	*set = files
	return nil
}

func decodeSkillText(raw json.RawMessage, out *string, limit int) bool {
	return len(raw) > 0 && raw[0] == '"' && json.Unmarshal(raw, out) == nil && len(*out) <= limit
}

func (set skillFileSet) matches(pin skillPin) bool {
	f, ok := set[pin.ID]
	if !ok || f.References == nil || len(pin.ReferenceHashes) != len(f.References) ||
		!matchesSkillDigest(f.Manifest, pin.ManifestSHA256, 64<<10) || !matchesSkillDigest(f.Main, pin.SHA256, 8<<10) {
		return false
	}
	for ref, hash := range pin.ReferenceHashes {
		text, ok := f.References[ref]
		if !ok || !matchesSkillDigest(text, hash, 128<<10) {
			return false
		}
	}
	return true
}

func matchesSkillDigest(text, hash string, limit int) bool {
	return len(text) <= limit && utf8.ValidString(text) && fmt.Sprintf("%x", sha256.Sum256([]byte(text))) == hash
}

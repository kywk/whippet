package manager

import (
	"bytes"
	"encoding/json"
	"math"
	"regexp"
	"unicode/utf8"
)

// The pinned registry owns schema; unsupported keywords fail closed at load time.
type toolSchema struct {
	Type          json.RawMessage       `json:"type"`
	Properties    map[string]toolSchema `json:"properties"`
	Required      []string              `json:"required"`
	Additional    json.RawMessage       `json:"additionalProperties"`
	Names         *toolSchema           `json:"propertyNames"`
	Items         *toolSchema           `json:"items"`
	OneOf         []toolSchema          `json:"oneOf"`
	Const         json.RawMessage       `json:"const"`
	Enum          []json.RawMessage     `json:"enum"`
	Minimum       *float64              `json:"minimum"`
	Maximum       *float64              `json:"maximum"`
	MinItems      *int                  `json:"minItems"`
	MaxItems      *int                  `json:"maxItems"`
	MaxProperties *int                  `json:"maxProperties"`
	MinLength     *int                  `json:"minLength"`
	MaxLength     *int                  `json:"maxLength"`
	Pattern       *string               `json:"pattern"`
	Format        *string               `json:"format"`
	UTF8Bytes     *int                  `json:"x-maxUtf8Bytes"`
	JSONBytes     *int                  `json:"x-maxJsonBytes"`
	Depth         *int                  `json:"x-maxDepth"`
}

func parseToolSchema(raw []byte) (*toolSchema, error) {
	var fields map[string]json.RawMessage
	if json.Unmarshal(raw, &fields) != nil || fields == nil {
		return nil, errCapability
	}
	for key, value := range fields {
		if key != "const" && bytes.Equal(bytes.TrimSpace(value), []byte("null")) {
			return nil, errCapability
		}
	}
	for _, key := range []string{"oneOf", "enum"} {
		if rawValue, ok := fields[key]; ok {
			var list []json.RawMessage
			if json.Unmarshal(rawValue, &list) != nil || len(list) == 0 {
				return nil, errCapability
			}
		}
	}
	var s toolSchema
	d := json.NewDecoder(bytes.NewReader(raw))
	d.DisallowUnknownFields()
	if d.Decode(&s) != nil || !s.valid(0) {
		return nil, errCapability
	}
	return &s, nil
}
func (s toolSchema) valid(depth int) bool {
	if depth > 64 {
		return false
	}
	if len(s.Type) > 0 {
		var one string
		var many []string
		if json.Unmarshal(s.Type, &one) == nil {
			many = []string{one}
		} else if json.Unmarshal(s.Type, &many) != nil || len(many) == 0 {
			return false
		}
		seen := map[string]bool{}
		for _, t := range many {
			if seen[t] {
				return false
			}
			seen[t] = true
			switch t {
			case "null", "boolean", "number", "integer", "string", "array", "object":
			default:
				return false
			}
		}
	}
	for _, n := range []*int{s.MinItems, s.MaxItems, s.MaxProperties, s.MinLength, s.MaxLength, s.UTF8Bytes, s.JSONBytes, s.Depth} {
		if n != nil && *n < 0 {
			return false
		}
	}
	if s.Format != nil && *s.Format != "uuid" {
		return false
	}
	if s.Pattern != nil {
		if _, err := regexp.Compile(*s.Pattern); err != nil {
			return false
		}
	}
	seen := map[string]bool{}
	for _, k := range s.Required {
		if _, ok := s.Properties[k]; !ok || seen[k] {
			return false
		}
		seen[k] = true
	}
	for k, p := range s.Properties {
		if unsafeToolKey(k) || !p.valid(depth+1) {
			return false
		}
	}
	for _, p := range []*toolSchema{s.Names, s.Items} {
		if p != nil && !p.valid(depth+1) {
			return false
		}
	}
	for _, p := range s.OneOf {
		if !p.valid(depth + 1) {
			return false
		}
	}
	if len(s.Additional) > 0 && !bytes.Equal(s.Additional, []byte("true")) && !bytes.Equal(s.Additional, []byte("false")) {
		if _, err := parseToolSchema(s.Additional); err != nil {
			return false
		}
	}
	return true
}
func unsafeToolKey(k string) bool { return k == "__proto__" || k == "prototype" || k == "constructor" }
func toolJSONDepth(v any, depth int) (int, bool) {
	if depth > 64 {
		return 0, false
	}
	max := depth
	switch x := v.(type) {
	case map[string]any:
		max++
		for k, item := range x {
			if unsafeToolKey(k) {
				return 0, false
			}
			d, ok := toolJSONDepth(item, depth+1)
			if !ok {
				return 0, false
			}
			if d > max {
				max = d
			}
		}
	case []any:
		max++
		for _, item := range x {
			d, ok := toolJSONDepth(item, depth+1)
			if !ok {
				return 0, false
			}
			if d > max {
				max = d
			}
		}
	case float64:
		if math.IsNaN(x) || math.IsInf(x, 0) {
			return 0, false
		}
	case nil, bool, string:
	default:
		return 0, false
	}
	return max, true
}
func (s toolSchema) matches(v any) bool {
	depth, ok := toolJSONDepth(v, 0)
	if !ok || s.Depth != nil && depth > *s.Depth {
		return false
	}
	encoded, err := json.Marshal(v)
	if err != nil || s.JSONBytes != nil && len(encoded) > *s.JSONBytes {
		return false
	}
	if len(s.OneOf) > 0 {
		n := 0
		for _, p := range s.OneOf {
			if p.matches(v) {
				n++
			}
		}
		if n != 1 {
			return false
		}
	}
	equal := func(raw []byte) bool {
		var x any
		if json.Unmarshal(raw, &x) != nil {
			return false
		}
		b, _ := json.Marshal(x)
		return bytes.Equal(encoded, b)
	}
	if len(s.Const) > 0 && !equal(s.Const) {
		return false
	}
	if s.Enum != nil {
		found := false
		for _, x := range s.Enum {
			found = found || equal(x)
		}
		if !found {
			return false
		}
	}
	if len(s.Type) > 0 {
		var one string
		var many []string
		if json.Unmarshal(s.Type, &one) == nil {
			many = []string{one}
		} else {
			_ = json.Unmarshal(s.Type, &many)
		}
		found := false
		for _, t := range many {
			switch x := v.(type) {
			case nil:
				found = found || t == "null"
			case bool:
				found = found || t == "boolean"
			case float64:
				found = found || t == "number" || t == "integer" && math.Trunc(x) == x && math.Abs(x) <= 9007199254740991
			case string:
				found = found || t == "string"
			case []any:
				found = found || t == "array"
			case map[string]any:
				found = found || t == "object"
			}
		}
		if !found {
			return false
		}
	}
	switch x := v.(type) {
	case float64:
		if s.Minimum != nil && x < *s.Minimum || s.Maximum != nil && x > *s.Maximum {
			return false
		}
	case string:
		if !utf8.ValidString(x) || s.MinLength != nil && utf8.RuneCountInString(x) < *s.MinLength || s.MaxLength != nil && utf8.RuneCountInString(x) > *s.MaxLength || s.UTF8Bytes != nil && len(x) > *s.UTF8Bytes || s.Format != nil && !uuidPattern.MatchString(x) {
			return false
		}
		if s.Pattern != nil {
			r, e := regexp.Compile(*s.Pattern)
			if e != nil || !r.MatchString(x) {
				return false
			}
		}
	case []any:
		if s.MinItems != nil && len(x) < *s.MinItems || s.MaxItems != nil && len(x) > *s.MaxItems {
			return false
		}
		for _, item := range x {
			if s.Items != nil && !s.Items.matches(item) {
				return false
			}
		}
	case map[string]any:
		if s.MaxProperties != nil && len(x) > *s.MaxProperties {
			return false
		}
		for _, k := range s.Required {
			if _, ok := x[k]; !ok {
				return false
			}
		}
		for k, item := range x {
			if s.Names != nil && !s.Names.matches(k) {
				return false
			}
			if p, ok := s.Properties[k]; ok {
				if !p.matches(item) {
					return false
				}
			} else if bytes.Equal(s.Additional, []byte("false")) {
				return false
			} else if len(s.Additional) > 0 && !bytes.Equal(s.Additional, []byte("true")) {
				p, e := parseToolSchema(s.Additional)
				if e != nil || !p.matches(item) {
					return false
				}
			}
		}
	}
	return true
}
func validToolArguments(tool registryTool, raw json.RawMessage) bool {
	if !utf8.Valid(raw) {
		return false
	}
	var v any
	if json.Unmarshal(raw, &v) != nil {
		return false
	}
	s, e := parseToolSchema(tool.InputSchema)
	if e != nil || !s.matches(v) {
		return false
	}
	var compact bytes.Buffer
	if json.Compact(&compact, raw) != nil || int64(compact.Len()) > tool.Limits.MaxInputBytes {
		return false
	}
	if tool.Name == "propose_plan" {
		obj, ok := v.(map[string]any)
		if !ok {
			return false
		}
		stages, ok := obj["stages"].([]any)
		if !ok {
			return false
		}
		for _, stage := range stages {
			st := stage.(map[string]any)
			if _, ok := st["args"].(map[string]any)["page"]; ok {
				return false
			}
		}
	}
	return true
}

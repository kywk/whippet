package server

import (
	"encoding/json"
	"math"
	"reflect"
	"regexp"
	"unicode/utf8"
)

// validateToolArguments interprets the packaged registry, including its guard
// extensions. No provider-side schema validation is trusted by this boundary.
func validateToolArguments(tool ToolDefinition, raw []byte) ([]byte, error) {
	var value any
	var schema map[string]any
	if !utf8.Valid(raw) || json.Unmarshal(raw, &value) != nil || json.Unmarshal(tool.InputSchema, &schema) != nil {
		return nil, ErrInvalid
	}
	canonical, err := json.Marshal(value)
	if err != nil || len(canonical) > tool.Limits.MaxInputBytes || !safeJSON(value, 0, 128) || !matchesToolSchema(schema, value) {
		return nil, ErrInvalid
	}
	return canonical, nil
}
func unsafeJSONKey(key string) bool {
	return key == "__proto__" || key == "prototype" || key == "constructor"
}
func safeJSON(v any, depth, max int) bool {
	switch x := v.(type) {
	case map[string]any:
		if depth > max {
			return false
		}
		for k, v := range x {
			if unsafeJSONKey(k) || !safeJSON(v, depth+1, max) {
				return false
			}
		}
	case []any:
		if depth > max {
			return false
		}
		for _, v := range x {
			if !safeJSON(v, depth+1, max) {
				return false
			}
		}
	case float64:
		return !math.IsNaN(x) && !math.IsInf(x, 0)
	}
	return true
}
func schemaType(t string, v any) bool {
	switch t {
	case "null":
		return v == nil
	case "object":
		_, ok := v.(map[string]any)
		return ok
	case "array":
		_, ok := v.([]any)
		return ok
	case "string":
		_, ok := v.(string)
		return ok
	case "boolean":
		_, ok := v.(bool)
		return ok
	case "number":
		_, ok := v.(float64)
		return ok
	case "integer":
		n, ok := v.(float64)
		return ok && math.Trunc(n) == n
	}
	return false
}
func matchesToolSchema(s map[string]any, v any) bool {
	if t, ok := s["type"]; ok {
		valid := false
		switch x := t.(type) {
		case string:
			valid = schemaType(x, v)
		case []any:
			for _, t := range x {
				name, ok := t.(string)
				if ok && schemaType(name, v) {
					valid = true
				}
			}
		}
		if !valid {
			return false
		}
	}
	if c, ok := s["const"]; ok && !reflect.DeepEqual(c, v) {
		return false
	}
	if enums, ok := s["enum"].([]any); ok {
		matched := false
		for _, e := range enums {
			if reflect.DeepEqual(e, v) {
				matched = true
			}
		}
		if !matched {
			return false
		}
	}
	if choices, ok := s["oneOf"].([]any); ok {
		n := 0
		for _, c := range choices {
			sub, ok := c.(map[string]any)
			if ok && matchesToolSchema(sub, v) {
				n++
			}
		}
		if n != 1 {
			return false
		}
	}
	if n, ok := s["x-maxDepth"].(float64); ok && !safeJSON(v, 0, int(n)) {
		return false
	}
	if n, ok := s["x-maxJsonBytes"].(float64); ok {
		b, e := json.Marshal(v)
		if e != nil || len(b) > int(n) {
			return false
		}
	}
	switch x := v.(type) {
	case string:
		if n, ok := s["minLength"].(float64); ok && utf8.RuneCountInString(x) < int(n) {
			return false
		}
		if n, ok := s["maxLength"].(float64); ok && utf8.RuneCountInString(x) > int(n) {
			return false
		}
		if n, ok := s["x-maxUtf8Bytes"].(float64); ok && len(x) > int(n) {
			return false
		}
		if p, ok := s["pattern"].(string); ok {
			r, e := regexp.Compile(p)
			if e != nil || !r.MatchString(x) {
				return false
			}
		}
		if f, ok := s["format"].(string); ok && (f != "uuid" || !ValidID(x)) {
			return false
		}
	case float64:
		if n, ok := s["minimum"].(float64); ok && x < n {
			return false
		}
		if n, ok := s["maximum"].(float64); ok && x > n {
			return false
		}
	case []any:
		if n, ok := s["minItems"].(float64); ok && len(x) < int(n) {
			return false
		}
		if n, ok := s["maxItems"].(float64); ok && len(x) > int(n) {
			return false
		}
		if sub, ok := s["items"].(map[string]any); ok {
			for _, item := range x {
				if !matchesToolSchema(sub, item) {
					return false
				}
			}
		}
	case map[string]any:
		if n, ok := s["maxProperties"].(float64); ok && len(x) > int(n) {
			return false
		}
		if req, ok := s["required"].([]any); ok {
			for _, key := range req {
				k, ok := key.(string)
				if !ok {
					return false
				}
				if _, ok := x[k]; !ok {
					return false
				}
			}
		}
		props, _ := s["properties"].(map[string]any)
		for k, val := range x {
			if unsafeJSONKey(k) {
				return false
			}
			if sub, ok := s["propertyNames"].(map[string]any); ok {
				if k == "page" || !matchesToolSchema(sub, k) {
					return false
				}
			}
			if p, ok := props[k]; ok {
				sub, ok := p.(map[string]any)
				if !ok || !matchesToolSchema(sub, val) {
					return false
				}
				continue
			}
			switch additional := s["additionalProperties"].(type) {
			case bool:
				if !additional {
					return false
				}
			case map[string]any:
				if !matchesToolSchema(additional, val) {
					return false
				}
			}
		}
	}
	return true
}

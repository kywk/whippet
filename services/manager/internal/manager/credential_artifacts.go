package manager

import (
	"archive/zip"
	"bytes"
	"crypto/sha1"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"unicode/utf8"
)

func (m *Manager) rememberCredentials(r record, v credentialValues) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	current, ok := m.records[r.AttemptID]
	if !ok || current.RunID != r.RunID || current.CancelRequested || !current.holdsSlot() {
		return errCredentials
	}
	current.CredentialsUsed = true
	if err := atomicJSON(m.journalPath(current), current); err != nil {
		return errCredentials
	}
	m.records[r.AttemptID] = current
	if m.secrets == nil {
		m.secrets = make(map[string][]string)
	}
	m.secrets[r.AttemptID] = append(m.secrets[r.AttemptID], v.Username, v.Password)
	return nil
}
func secretReplacer(values []string) *strings.Replacer {
	sort.Slice(values, func(i, j int) bool { return len(values[i]) > len(values[j]) })
	pairs := []string{}
	for _, v := range values {
		if v == "" {
			continue
		}
		escaped, _ := json.Marshal(v)
		for _, s := range []string{v, string(escaped[1 : len(escaped)-1]), url.QueryEscape(v), url.PathEscape(v)} {
			pairs = append(pairs, s, "[redacted]")
		}
	}
	return strings.NewReplacer(pairs...)
}
func (m *Manager) redactCredentialLog(attempt, text string) string {
	m.mu.Lock()
	values := append([]string{}, m.secrets[attempt]...)
	m.mu.Unlock()
	return secretReplacer(values).Replace(text)
}

var embeddedReportZIP = regexp.MustCompile(`data:application/zip;base64,([A-Za-z0-9+/=]+)`)

// Keep the real Playwright report/results. Replace only known credential text;
// ZIP entries are bounded and rewritten with valid CRCs. Never fabricate stats.
func scrubCredentialBytes(data []byte, replacer *strings.Replacer, depth int) ([]byte, error) {
	if depth > 2 || len(data) > maxArtifactBytes {
		return nil, errCredentials
	}
	if len(data) >= 4 && (bytes.Equal(data[:4], []byte{'P', 'K', 3, 4}) || bytes.Equal(data[:4], []byte{'P', 'K', 5, 6})) {
		reader, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
		if err != nil || len(reader.File) > 4096 {
			return nil, errCredentials
		}
		var out bytes.Buffer
		writer := zip.NewWriter(&out)
		var total uint64
		for _, entry := range reader.File {
			total += entry.UncompressedSize64
			if total > 128<<20 || entry.UncompressedSize64 > maxArtifactBytes {
				writer.Close()
				return nil, errCredentials
			}
			body, err := entry.Open()
			if err != nil {
				return nil, errCredentials
			}
			raw, err := io.ReadAll(io.LimitReader(body, maxArtifactBytes+1))
			body.Close()
			if err != nil || len(raw) > maxArtifactBytes {
				return nil, errCredentials
			}
			// PNG/JPEG are masked at the browser source; never byte-edit pixels.
			if !strings.HasSuffix(strings.ToLower(entry.Name), ".png") && !strings.HasSuffix(strings.ToLower(entry.Name), ".jpeg") && !strings.HasSuffix(strings.ToLower(entry.Name), ".jpg") {
				raw, err = scrubCredentialBytes(raw, replacer, depth+1)
				if err != nil {
					return nil, err
				}
			}
			header := entry.FileHeader
			header.Method = zip.Deflate
			target, err := writer.CreateHeader(&header)
			if err != nil {
				return nil, errCredentials
			}
			if _, err = target.Write(raw); err != nil {
				return nil, errCredentials
			}
		}
		if writer.Close() != nil || out.Len() > maxArtifactBytes {
			return nil, errCredentials
		}
		return out.Bytes(), nil
	}
	var rewriteErr error
	embedded := embeddedReportZIP.Match(data)
	data = embeddedReportZIP.ReplaceAllFunc(data, func(value []byte) []byte {
		parts := embeddedReportZIP.FindSubmatch(value)
		raw, err := base64.StdEncoding.DecodeString(string(parts[1]))
		if err != nil {
			rewriteErr = err
			return nil
		}
		clean, err := scrubCredentialBytes(raw, replacer, depth+1)
		if err != nil {
			rewriteErr = err
			return nil
		}
		return []byte("data:application/zip;base64," + base64.StdEncoding.EncodeToString(clean))
	})
	if rewriteErr != nil {
		return nil, errCredentials
	}
	if embedded {
		return data, nil
	} // Never rewrite the native report JavaScript shell.
	if json.Valid(data) {
		var value any
		if json.Unmarshal(data, &value) != nil {
			return nil, errCredentials
		}
		return json.Marshal(redactJSONStrings(value, replacer))
	}
	lines := bytes.Split(data, []byte("\n"))
	allJSON := len(lines) > 1
	for _, line := range lines {
		if len(bytes.TrimSpace(line)) > 0 && !json.Valid(line) {
			allJSON = false
			break
		}
	}
	if allJSON {
		for i, line := range lines {
			if len(bytes.TrimSpace(line)) == 0 {
				continue
			}
			var value any
			json.Unmarshal(line, &value)
			lines[i], _ = json.Marshal(redactJSONStrings(value, replacer))
		}
		return bytes.Join(lines, []byte("\n")), nil
	}
	return []byte(replacer.Replace(string(data))), nil
}

// Certify every decoded JSON string without rewriting Module source bytes.
// Token traversal rejects duplicate keys before they can hide a credential value.
func certifyModuleCredentialJSON(data []byte, replacer *strings.Replacer) error {
	if !utf8.Valid(data) {
		return errCredentials
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.UseNumber()
	checkString := func(value string) error {
		if replacer.Replace(value) != value {
			return errors.New("module candidate changed during redaction")
		}
		// Embedded report archives are not Module source evidence; retain fail-closed handling.
		if embeddedReportZIP.MatchString(value) {
			return errCredentials
		}
		return nil
	}
	var value func(int) error
	value = func(depth int) error {
		if depth > 64 {
			return errCredentials
		}
		token, err := decoder.Token()
		if err != nil {
			return errCredentials
		}
		switch token := token.(type) {
		case string:
			return checkString(token)
		case json.Delim:
			switch token {
			case '{':
				seen := make(map[string]bool)
				for decoder.More() {
					keyToken, err := decoder.Token()
					key, ok := keyToken.(string)
					if err != nil || !ok || seen[key] {
						return errCredentials
					}
					seen[key] = true
					if err := checkString(key); err != nil {
						return err
					}
					if err := value(depth + 1); err != nil {
						return err
					}
				}
				end, err := decoder.Token()
				if err != nil || end != json.Delim('}') {
					return errCredentials
				}
			case '[':
				for decoder.More() {
					if err := value(depth + 1); err != nil {
						return err
					}
				}
				end, err := decoder.Token()
				if err != nil || end != json.Delim(']') {
					return errCredentials
				}
			default:
				return errCredentials
			}
		}
		return nil
	}
	trimmed := bytes.TrimSpace(data)
	if len(trimmed) == 0 || trimmed[0] != '{' {
		return errCredentials
	}
	if err := value(0); err != nil {
		return err
	}
	if _, err := decoder.Token(); err != io.EOF {
		return errCredentials
	}
	return nil
}

func sanitizeCredentialOutputs(taskDir string, values []string, authors ...*AuthorTask) error {
	if len(values) == 0 {
		return errors.New("credential evidence cannot be certified after restart")
	}
	root, err := openOutputRoot(taskDir)
	if err != nil {
		return err
	}
	defer root.Close()
	replacer := secretReplacer(values)
	renames := []string{}
	entries, err := os.ReadDir(filepath.Join(taskDir, "output", "data"))
	if err != nil && !os.IsNotExist(err) {
		return err
	}
	for _, entry := range entries {
		name := "data/" + entry.Name()
		if !evidencePattern.MatchString(name) {
			continue
		}
		file, err := openArtifact(taskDir, name)
		if err != nil {
			return err
		}
		data, err := io.ReadAll(file)
		file.Close()
		if err != nil {
			return err
		}
		clean, err := scrubCredentialBytes(data, replacer, 0)
		if err != nil {
			return err
		}
		if !bytes.Equal(data, clean) {
			next := fmtHash(clean) + filepath.Ext(name)
			if err := root.WriteFile("data/"+next, clean, 0600); err != nil {
				return err
			}
			if err := root.Remove(name); err != nil {
				return err
			}
			renames = append(renames, entry.Name(), next)
		}
	}
	if len(renames) > 0 {
		pairs := []string{}
		for i := 0; i < len(renames); i += 2 {
			pairs = append(pairs, renames[i], renames[i+1])
		}
		// Include attachment name substitutions inside embedded HTML ZIP JSON too.
		pairs = append(pairs, secretPairs(values)...)
		replacer = strings.NewReplacer(pairs...)
	}
	for _, name := range []string{"report.html", "results.json", "author.json", "result.json"} {
		file, err := openArtifact(taskDir, name, authors...)
		if os.IsNotExist(err) {
			continue
		}
		if err != nil {
			return err
		}
		data, err := io.ReadAll(file)
		file.Close()
		if err != nil {
			return err
		}
		if name == "author.json" && len(authors) == 1 && moduleAuthor(authors[0]) {
			if err := certifyModuleCredentialJSON(data, replacer); err != nil {
				return err
			}
			continue // Clean Module bytes (including key order/newline) remain immutable.
		}
		clean, err := scrubCredentialBytes(data, replacer, 0)
		if err != nil {
			return err
		}
		if err := root.WriteFile(name, clean, 0600); err != nil {
			return err
		}
	}
	// Raw reporter working copies are no longer needed and may contain secrets.
	_ = os.RemoveAll(filepath.Join(taskDir, "output", "html"))
	_ = os.RemoveAll(filepath.Join(taskDir, "output", "test-results"))
	return nil
}
func fmtHash(data []byte) string {
	sum := sha1.Sum(data)
	const hex = "0123456789abcdef"
	out := make([]byte, 40)
	for i, b := range sum {
		out[2*i] = hex[b>>4]
		out[2*i+1] = hex[b&15]
	}
	return string(out)
}
func secretPairs(values []string) []string {
	pairs := []string{}
	for _, v := range values {
		if v != "" {
			b, _ := json.Marshal(v)
			for _, s := range []string{v, string(b[1 : len(b)-1]), url.QueryEscape(v), url.PathEscape(v)} {
				pairs = append(pairs, s, "[redacted]")
			}
		}
	}
	return pairs
}

func redactJSONStrings(value any, r *strings.Replacer) any {
	switch v := value.(type) {
	case string:
		return r.Replace(v)
	case []any:
		for i, item := range v {
			v[i] = redactJSONStrings(item, r)
		}
	case map[string]any:
		for key, item := range v {
			v[key] = redactJSONStrings(item, r)
		}
	}
	return value
}

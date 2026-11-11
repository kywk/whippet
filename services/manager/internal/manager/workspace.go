package manager

import (
	"bytes"
	"encoding/json"
	"errors"
	"net/url"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf8"
)

// Keep the original RawMessage for input.json; validation must not normalize a
// queued task's immutable Workspace settings or fetch current settings.
func validWorkspaceSettings(data json.RawMessage) error {
	if len(data) == 0 {
		return nil
	} // Pre-M5 dispatch.
	var snapshot *struct {
		Revision int64 `json:"revision"`
		Sites    []struct {
			Name string `json:"name"`
			URL  string `json:"url"`
		} `json:"sites"`
		DefaultTestURL *string `json:"defaultTestUrl"`
		TimeoutMS      int64   `json:"timeoutMs"`
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	invalid := errors.New("invalid workspaceSettings snapshot")
	if decoder.Decode(&snapshot) != nil || snapshot == nil || snapshot.Revision < 1 || snapshot.Revision > 9007199254740991 ||
		snapshot.TimeoutMS < 1 || snapshot.TimeoutMS > 3600000 || snapshot.Sites == nil || len(snapshot.Sites) > 20 ||
		snapshot.DefaultTestURL == nil || *snapshot.DefaultTestURL != "" && !workspaceHTTPURL(*snapshot.DefaultTestURL) {
		return invalid
	}
	for _, site := range snapshot.Sites {
		name := strings.TrimSpace(site.Name)
		if name == "" || utf8.RuneCountInString(name) > 100 || !workspaceHTTPURL(site.URL) {
			return invalid
		}
	}
	return nil
}

func workspaceHTTPURL(value string) bool {
	if !utf8.ValidString(value) || utf8.RuneCountInString(value) > 2048 || strings.IndexFunc(value, unicode.IsSpace) >= 0 || strings.IndexFunc(value, unicode.IsControl) >= 0 {
		return false
	}
	u, err := url.Parse(value)
	if err != nil || !(strings.EqualFold(u.Scheme, "http") || strings.EqualFold(u.Scheme, "https")) || u.Hostname() == "" || u.User != nil || u.Opaque != "" {
		return false
	}
	if port := u.Port(); port != "" {
		n, err := strconv.Atoi(port)
		return err == nil && n > 0 && n <= 65535
	}
	return !strings.HasSuffix(u.Host, ":")
}

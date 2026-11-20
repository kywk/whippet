package server

import (
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path"
	"regexp"
	"strings"
	"unicode/utf8"
)

type InspectionConfig struct {
	Sources []inspectionSource `json:"sources"`
}

type inspectionSource struct {
	WorkspaceID         string           `json:"workspaceId"`
	Environment         string           `json:"environment"`
	ProjectSlug         string           `json:"projectSlug"`
	DeploymentProofPath string           `json:"deploymentProofPath,omitempty"`
	TargetOrigin        string           `json:"targetOrigin"`
	FeedbackOrigin      string           `json:"feedbackDeskOrigin"`
	BridgeTokenHash     string           `json:"bridgeTokenSha256"`
	ScheduleTokenHash   string           `json:"scheduleTokenSha256"`
	Tests               []inspectionTest `json:"tests"`
}

type inspectionTest struct {
	TestID         string              `json:"testId"`
	VersionIDs     []string            `json:"versionIds"`
	CheckKey       string              `json:"checkKey"`
	TestTitle      string              `json:"testTitle"`
	AssertionTitle string              `json:"assertionTitle"`
	RetestChecks   []retestCheckConfig `json:"retestChecks,omitempty"`
}

var (
	inspectionIdentifier  = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$`)
	inspectionProjectSlug = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]{0,79}$`)
	inspectionDigest      = regexp.MustCompile(`^[a-f0-9]{64}$`)
	inspectionProofPath   = regexp.MustCompile(`^/[A-Za-z0-9._/-]{1,255}$`)
	inspectionBearer      = regexp.MustCompile(`^[A-Za-z0-9_-]{43,128}$`)
)

func LoadInspectionConfig(path string) (*InspectionConfig, error) {
	if path == "" {
		return nil, nil
	}
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Size() > 256<<10 {
		return nil, errors.New("inspection configuration must be a bounded regular file")
	}
	var config InspectionConfig
	dec := json.NewDecoder(io.LimitReader(f, 256<<10))
	dec.DisallowUnknownFields()
	if dec.Decode(&config) != nil || dec.Decode(new(any)) != io.EOF || !config.valid() {
		return nil, errors.New("invalid inspection configuration")
	}
	return &config, nil
}

func inspectionID(id string) bool {
	return ValidID(id) && strings.ToLower(id) == id
}

func inspectionTitle(title string) bool {
	return title != "" && strings.TrimSpace(title) == title && len(title) <= 320 &&
		utf8.ValidString(title) && !strings.ContainsAny(title, "\x00\r\n")
}

func (c *InspectionConfig) valid() bool {
	if len(c.Sources) == 0 || len(c.Sources) > 100 {
		return false
	}
	tokens := make(map[string]bool)
	sourceKeys := make(map[string]bool)
	for _, source := range c.Sources {
		target, targetErr := normalizedOrigin(source.TargetOrigin)
		feedback, feedbackErr := normalizedOrigin(source.FeedbackOrigin)
		key := source.WorkspaceID + "\x00" + source.Environment
		if !inspectionID(source.WorkspaceID) || !inspectionIdentifier.MatchString(source.Environment) ||
			!inspectionProjectSlug.MatchString(source.ProjectSlug) || targetErr != nil || target != source.TargetOrigin ||
			feedbackErr != nil || feedback != source.FeedbackOrigin || sourceKeys[key] ||
			source.DeploymentProofPath != "" && !validInspectionProofPath(source.DeploymentProofPath) ||
			len(source.Tests) == 0 || len(source.Tests) > 100 {
			return false
		}
		sourceKeys[key] = true
		for _, hash := range []string{source.BridgeTokenHash, source.ScheduleTokenHash} {
			if !inspectionDigest.MatchString(hash) || tokens[hash] {
				return false
			}
			tokens[hash] = true
		}
		tests := make(map[string]bool)
		for _, test := range source.Tests {
			if !inspectionID(test.TestID) || tests[test.TestID] || !inspectionIdentifier.MatchString(test.CheckKey) ||
				!inspectionTitle(test.TestTitle) || !inspectionTitle(test.AssertionTitle) ||
				!validRetestChecks(test) || len(test.VersionIDs) == 0 || len(test.VersionIDs) > 100 {
				return false
			}
			tests[test.TestID] = true
			versions := make(map[string]bool)
			for _, version := range test.VersionIDs {
				if !inspectionID(version) || versions[version] {
					return false
				}
				versions[version] = true
			}
		}
	}
	return true
}

func (c *InspectionConfig) source(workspace, secret string, schedule bool) *inspectionSource {
	if c == nil || !inspectionBearer.MatchString(secret) {
		return nil
	}
	digest := sha256.Sum256([]byte(secret))
	hash := hex.EncodeToString(digest[:])
	for i := range c.Sources {
		source := &c.Sources[i]
		want := source.BridgeTokenHash
		if schedule {
			want = source.ScheduleTokenHash
		}
		if source.WorkspaceID == workspace && subtle.ConstantTimeCompare([]byte(hash), []byte(want)) == 1 {
			return source
		}
	}
	return nil
}

func (s *inspectionSource) test(id string) (inspectionTest, bool) {
	for _, test := range s.Tests {
		if test.TestID == id {
			return test, true
		}
	}
	return inspectionTest{}, false
}

type retestCheckConfig struct {
	CheckKey       string `json:"checkKey"`
	TestTitle      string `json:"testTitle"`
	AssertionTitle string `json:"assertionTitle"`
}

func validInspectionProofPath(value string) bool {
	return inspectionProofPath.MatchString(value) && path.Clean(value) == value
}

func (t inspectionTest) checks() map[string]string {
	checks := map[string]string{t.CheckKey: scriptHash(t.TestTitle + "\x00" + t.AssertionTitle)}
	for _, check := range t.RetestChecks {
		checks[check.CheckKey] = scriptHash(check.TestTitle + "\x00" + check.AssertionTitle)
	}
	return checks
}

func validRetestChecks(t inspectionTest) bool {
	if len(t.RetestChecks) > maxRetestChecks-1 {
		return false
	}
	keys := map[string]bool{t.CheckKey: true}
	for _, check := range t.RetestChecks {
		if !inspectionIdentifier.MatchString(check.CheckKey) || keys[check.CheckKey] ||
			!inspectionTitle(check.TestTitle) || !inspectionTitle(check.AssertionTitle) {
			return false
		}
		keys[check.CheckKey] = true
	}
	digests := make(map[string]bool)
	for _, digest := range t.checks() {
		if digests[digest] {
			return false
		}
		digests[digest] = true
	}
	return true
}

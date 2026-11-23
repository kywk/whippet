package manager

import (
	"bytes"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func authorWithFiles(t *testing.T) *AuthorTask {
	t.Helper()
	a := v10Author(t)
	a.SkillFiles = skillFileSet{*a.SkillID: {Main: "測試\r\n<&>\n", Manifest: "{\n  \"id\":\"test-author\"\n}\n", References: map[string]string{"guide": "繁體中文\n"}}}
	pinFileFixture(a)
	return a
}

func pinFileFixture(a *AuthorTask) {
	id := *a.SkillID
	f := a.SkillFiles[id]
	hashes := map[string]string{}
	digest := func(s string) string { return fmt.Sprintf("%x", sha256.Sum256([]byte(s))) }
	for k, v := range f.References {
		hashes[k] = digest(v)
	}
	a.Skills, _ = json.Marshal([]skillPin{{ID: id, Version: *a.SkillVersion, SHA256: digest(f.Main), ManifestSHA256: digest(f.Manifest), ReferenceHashes: hashes}})
}

func TestSkillFilesDispatchWorkerInputAndRecovery(t *testing.T) {
	m, docker, ctx := lifecycleManager(t, 1)
	d := m7Dispatch(t, false)
	d.Author = authorWithFiles(t)
	dispatch := message("manager-test", "dispatch", newID(), newID(), d)
	fixture := docker.add(dispatch)
	if err := m.accept(ctx, dispatch); err != nil && err.Error() != "Manager is offline" {
		t.Fatal(err)
	}
	awaitAttempt(t, docker.started, dispatch.AttemptID)
	loaded, err := loadRecords(m.cfg.WorkDir)
	if err != nil {
		t.Fatal(err)
	}
	r := loaded[dispatch.AttemptID]
	data, err := os.ReadFile(filepath.Join(m.taskDir(r), "input.json"))
	if err != nil {
		t.Fatal(err)
	}
	var input WorkerInput
	if err = json.Unmarshal(data, &input); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(input.Author.SkillFiles, d.Author.SkillFiles) {
		t.Fatal("Worker input lost pinned bytes")
	}
	journal, err := os.ReadFile(m.journalPath(r))
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(journal, []byte(`"skillFiles"`)) {
		t.Fatal("inline files persisted to journal")
	}
	want := *d.Author
	want.SkillFiles = nil
	if !reflect.DeepEqual(r.Author, &want) {
		t.Fatal("recovery lost immutable pins or metadata")
	}
	close(fixture.reclaim)
}

func TestSkillFilesRejectInvalidBundles(t *testing.T) {
	cases := map[string]func(*AuthorTask, *skillFiles){
		"main-digest":       func(a *AuthorTask, f *skillFiles) { f.Main += "x" },
		"manifest-digest":   func(a *AuthorTask, f *skillFiles) { f.Manifest += "x" },
		"reference-digest":  func(a *AuthorTask, f *skillFiles) { f.References["guide"] += "x" },
		"missing-reference": func(a *AuthorTask, f *skillFiles) { delete(f.References, "guide") },
		"extra-slot":        func(a *AuthorTask, f *skillFiles) { a.SkillFiles["other"] = *f },
		"without-pins":      func(a *AuthorTask, f *skillFiles) { a.Skills = nil },
	}
	for name, change := range cases {
		t.Run(name, func(t *testing.T) {
			a := authorWithFiles(t)
			id := *a.SkillID
			f := a.SkillFiles[id]
			change(a, &f)
			a.SkillFiles[id] = f
			if _, err := validCapabilitySnapshot(a); err == nil {
				t.Fatal("accepted invalid bundle")
			}
		})
	}
	for _, raw := range []string{`null`, `{}`, `{"s":{"main":"a","main":"b","manifest":"","references":{}}}`, `{"s":{"main":"","manifest":"","references":null}}`, `{"s":{"main":null,"manifest":"","references":{}}}`, `{"s":{"main":"","manifest":"","references":{"a":"b","a":"c"}}}`, `{"../s":{"main":"","manifest":"","references":{}}}`} {
		var files skillFileSet
		if json.Unmarshal([]byte(raw), &files) == nil {
			t.Fatal("accepted invalid file shape")
		}
	}
}

func TestSkillFilesSizeLimits(t *testing.T) {
	for _, size := range []int{0, 1} {
		for _, part := range []string{"main", "manifest", "ref", "total"} {
			a := authorWithFiles(t)
			id := *a.SkillID
			f := a.SkillFiles[id]
			switch part {
			case "main":
				f.Main = strings.Repeat("x", (8<<10)+size)
			case "manifest":
				f.Manifest = strings.Repeat("x", (64<<10)+size)
			case "ref":
				f.References["guide"] = strings.Repeat("x", (128<<10)+size)
			case "total":
				f.References = map[string]string{}
				for _, k := range []string{"a", "b", "c", "d"} {
					f.References[k] = strings.Repeat("x", 128<<10)
				}
				a.SkillFiles[id] = f
				encoded, _ := json.Marshal(a.SkillFiles)
				f.References["d"] = f.References["d"][:(128<<10)-(len(encoded)-maxSkillFilesBytes)+size]
			}
			a.SkillFiles[id] = f
			pinFileFixture(a)
			_, err := validCapabilitySnapshot(a)
			if (err != nil) != (size == 1) {
				t.Fatalf("unexpected limit at %s + %d: %v", part, size, err)
			}
		}
	}
}

package server

import (
	"context"
	"os"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

// Only explicitly reviewed, packaged skill content is MCP-readable. Manifests
// contain internal model policy and are never exposed as resources.
func addMCPResources(server *mcp.Server, registry *ToolRegistry, api *API, store *Postgres) bool {
	root := os.Getenv("WHIPPET_SKILLS_PATH")
	if root == "" {
		root = repositoryFile("runtimes", "worker", "skills")
	}
	added := false
	for _, id := range []string{"catalog-reuse", "test-author", "acceptance-summary"} {
		manifest, pin, err := loadSkill(root, id, registry)
		if err != nil {
			return false
		}
		main, err := readSkillFile(root, id+"/SKILL.md", 8192)
		if err != nil || scriptHash(string(main)) != pin.SHA256 {
			return false
		}
		addMCPResource(server, api, store, "whippet://skill/"+id+"/main", id, main)
		added = true
		for _, ref := range manifest.References {
			if (id == "test-author" || id == "acceptance-summary") && ref.ID != "external-mcp" {
				continue
			}
			data, err := readSkillFile(root, id+"/"+ref.Path, 128<<10)
			if err != nil || scriptHash(string(data)) != ref.SHA256 {
				return false
			}
			addMCPResource(server, api, store, "whippet://skill/"+id+"/references/"+ref.ID, id+"/"+ref.ID, data)
		}
	}
	return added
}

func addMCPResource(server *mcp.Server, api *API, store *Postgres, uri, name string, body []byte) {
	content := string(body)
	server.AddResource(&mcp.Resource{Name: name, URI: uri, MIMEType: "text/markdown", Size: int64(len(body))}, func(ctx context.Context, _ *mcp.ReadResourceRequest) (*mcp.ReadResourceResult, error) {
		if _, err := api.recheckAgent(ctx, store); err != nil {
			return nil, mcp.ResourceNotFoundError(uri)
		}
		return &mcp.ReadResourceResult{Contents: []*mcp.ResourceContents{{URI: uri, MIMEType: "text/markdown", Text: content}}}, nil
	})
}

package server

import "testing"

func TestStageSplitBudgetConservation(t *testing.T) {
	cap := 16384
	total := AuthorBudget{MaxModelRequests: 8, MaxToolCalls: 12, MaxDurationMS: 180000, MaxOutputTokens: &cap}
	for _, n := range []int{2} {
		stages := []PlanStageInput{{ID: "a"}, {ID: "b"}, {ID: "c"}}[:n]
		parts, err := stageSplitBudgets(total, stages)
		if err != nil {
			t.Fatal(err)
		}
		requests, tools, duration := 0, 0, 0
		for _, p := range parts {
			requests += p.MaxModelRequests
			tools += p.MaxToolCalls
			duration += p.MaxDurationMS
			if p.MaxModelRequests < 3 || p.MaxToolCalls < 3 || p.effectiveMaxOutputTokens() != 16384 {
				t.Fatal("unusable/inflated allocation")
			}
		}
		if requests != 8 || tools != 12 || duration != 180000 {
			t.Fatal("split minted or lost budget")
		}
	}
	for _, stages := range [][]PlanStageInput{{{ID: "a"}}, {{ID: "a"}, {ID: "a"}}, {{ID: "a"}, {ID: "b"}, {ID: "c"}}} {
		if _, err := stageSplitBudgets(total, stages); err == nil {
			t.Fatal("invalid split")
		}
	}
	total.MaxToolCalls = 5
	if _, err := stageSplitBudgets(total, []PlanStageInput{{ID: "a"}, {ID: "b"}}); err == nil {
		t.Fatal("insufficient budget accepted")
	}
}

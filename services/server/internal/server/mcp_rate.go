package server

import (
	"sync"
	"time"
)

type agentRateBucket struct {
	tokens float64
	last   time.Time
}

type agentRateLimiter struct {
	mu      sync.Mutex
	buckets map[string]agentRateBucket
}

func newAgentRateLimiter() *agentRateLimiter {
	return &agentRateLimiter{buckets: make(map[string]agentRateBucket)}
}

func (l *agentRateLimiter) allow(id string, now time.Time) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	b, found := l.buckets[id]
	if !found {
		if len(l.buckets) >= 4096 {
			for key, old := range l.buckets {
				if now.Sub(old.last) > 10*time.Minute {
					delete(l.buckets, key)
				}
			}
			if len(l.buckets) >= 4096 {
				return false
			}
		}
		b = agentRateBucket{tokens: 10, last: now}
	}
	if elapsed := now.Sub(b.last).Seconds(); elapsed > 0 {
		b.tokens += elapsed
		if b.tokens > 10 {
			b.tokens = 10
		}
	}
	b.last = now
	allowed := b.tokens >= 1
	if allowed {
		b.tokens--
	}
	l.buckets[id] = b
	return allowed
}

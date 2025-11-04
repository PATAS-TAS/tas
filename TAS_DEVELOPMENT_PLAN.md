# TAS Development Plan

## Current Status

✅ **MVP Completed:**
- Basic spam detection (Rules + LLM)
- API deployed to Fly.io
- False positives fixed (short messages)

## Next Steps (Phase 1 - Critical)

### 1. Rule Import from PATAS
- [ ] Create `app/rule_importer.py` to fetch rules from PATAS `/export-rules`
- [ ] Parse ROL format (JSON with id, pattern, weight, etc.)
- [ ] Store rules in memory with versioning
- [ ] Support rule updates (polling or webhook)

### 2. RRS (Reputation & Rate Sentinel)
- [ ] Track sender frequency per IP/user
- [ ] Detect burst patterns
- [ ] Implement reputation scoring
- [ ] Store in memory (TTL-based)

### 3. LUR (Link & URL Risk)
- [ ] Unpack redirects (bit.ly → final URL)
- [ ] Check domain age, TLD risk
- [ ] Hash target pages for comparison
- [ ] Cache URL resolutions

### 4. SIG (Signatures)
- [ ] Generate shingling/n-grams for messages
- [ ] Match against known spam signatures from PATAS
- [ ] Cluster similar messages
- [ ] Cache signatures

### 5. ROL (Rule Orchestrator)
- [ ] Import rules from PATAS
- [ ] Support shadow rules (test without affecting users)
- [ ] Canary rollout (10% → 50% → 100%)
- [ ] Auto-rollback on FP spike

### 6. QZN (Quarantine)
- [ ] Soft isolation of suspicious messages
- [ ] TTL-based release
- [ ] Status workflow: quarantined → released → banned

## Performance Targets

- P95 latency: < 100ms
- Throughput: 100+ req/sec per instance
- Memory: < 512MB per instance

## Integration Points

1. **PATAS `/export-rules`** - Fetch ruleset
2. **PATAS `/get-signature`** - Get message signature (for SIG)
3. **PATAS `/stats`** - Report metrics back

## Testing Strategy

1. Test rule import with real PATAS ruleset
2. Test each module independently
3. Integration tests for full pipeline
4. Performance tests for latency targets
5. Load tests for throughput

## Timeline

- **Week 1**: Rule import + RRS + LUR
- **Week 2**: SIG + ROL + QZN
- **Week 3**: Testing + optimization + documentation


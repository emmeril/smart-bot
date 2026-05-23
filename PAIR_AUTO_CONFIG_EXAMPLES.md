# Pair Auto-Config - Practical Examples

## Real-World Usage Scenarios

### Scenario 1: Trading BTC with Auto-Config

**Goal**: Trade BTC safely with automatic parameter calculation

**Step 1: Initial Setup**
```json
{
  "pair": "BTC/USDT",
  "gridOrderSizeUsdt": 50,
  "strategy": "spot_grid"
}
```

**System Auto-Calculates:**
- Detects: BTC is a MAJOR pair → uses major profile
- Sets gridLevels: 15
- Sets gridRangePercent: 2.5%
- Sets stopLossPercent: 2.0%
- Sets targetProfitMinUsdt: $0.25
- Sets targetProfitMaxUsdt: $2.00
- Sets trailing stop: Enabled at 1.8x ATR

**Result**: 15 grid orders spread across ±2.5% price range, with $0.25-$2.00 profit targets per trade

**Logs:**
```
[CONFIG][INFO] Auto-calculating parameters for pair BTC/USDT with order size $50.00
[CONFIG][INFO] Auto-calculated pair-specific parameters for BTC/USDT
```

---

### Scenario 2: Scaling Up Order Size

**Current Setup:**
```json
{
  "pair": "BTC/USDT",
  "gridOrderSizeUsdt": 50,
  "targetProfitMinUsdt": 0.25,
  "targetProfitMaxUsdt": 2.00
}
```

**Change: Increase order size to $100**

**User Updates:**
```json
{
  "gridOrderSizeUsdt": 100  ← Changed from 50
}
```

**System Detects Change:**
1. gridOrderSizeChanged = true
2. Recalculates with order size multiplier = 100/10 = 10
3. New TP targets = previous × 10

**New Parameters:**
```json
{
  "targetProfitMinUsdt": 0.50,   ← Was 0.25
  "targetProfitMaxUsdt": 4.00,   ← Was 2.00
  "gridLevels": 15,              ← Same (major pair)
  "stopLossPercent": 2.0%        ← Same
}
```

**Why?**
- Larger orders need proportionally larger absolute profit targets
- Risk percentage stays the same (2.0% SL)
- But $ amount scales with order size

**Logs:**
```
[CONFIG][INFO] Auto-calculating parameters for pair BTC/USDT with order size $100.00
[CONFIG][INFO] Auto-calculated pair-specific parameters for BTC/USDT
```

---

### Scenario 3: Switching from Stable to Volatile

**Current Setup (BTC):**
```json
{
  "pair": "BTC/USDT",
  "gridOrderSizeUsdt": 50,
  "gridLevels": 15,
  "gridRangePercent": 2.5,
  "stopLossPercent": 2.0,
  "targetProfitMaxUsdt": 2.00
}
```

**User Wants to Trade DOGE Instead:**

```json
{
  "pair": "DOGE/USDT",  ← Changed
  "gridOrderSizeUsdt": 50  ← Same order size
}
```

**System Auto-Adjustment:**
1. Detects: pair changed from BTC (major) to DOGE (smallcap)
2. Loads smallcap profile
3. Recalculates all parameters

**New Parameters:**
```json
{
  "pair": "DOGE/USDT",
  "gridLevels": 10,              ← Was 15 (fewer levels for volatility)
  "gridRangePercent": 5.0,       ← Was 2.5% (wider range)
  "stopLossPercent": 3.5,        ← Was 2.0% (higher tolerance)
  "targetProfitMinUsdt": 0.25,   ← Same (order size same)
  "targetProfitMaxUsdt": 2.00,   ← Same
  "riskRewardRatio": 1.2,        ← Was 1.5 (less aggressive)
  "stopLossAtrMultiplier": 1.6   ← Was 1.4 (more conservative)
}
```

**Why the Changes?**
- DOGE is more volatile → fewer grid levels (10 vs 15)
- DOGE needs wider range (5% vs 2.5%) to catch moves
- Higher SL tolerance (3.5% vs 2%) for volatile swings
- Profit targets stay proportional to order size

**Logs:**
```
[CONFIG][INFO] Auto-calculating parameters for pair DOGE/USDT with order size $50.00
[CONFIG][INFO] Auto-calculated pair-specific parameters for DOGE/USDT
[CONFIG][INFO] Grid parameters changed. Cleared locked grid state for rebuild.
```

---

### Scenario 4: Multi-Pair Portfolio

**Goal**: Trade 4 different pairs with auto-config

**Portfolio Configuration:**
```json
[
  {
    "pair": "BTC/USDT",
    "gridOrderSizeUsdt": 50,
    "profile": "major",
    "gridLevels": 15
  },
  {
    "pair": "ETH/USDT",
    "gridOrderSizeUsdt": 40,
    "profile": "major",
    "gridLevels": 15
  },
  {
    "pair": "MATIC/USDT",
    "gridOrderSizeUsdt": 20,
    "profile": "midcap",
    "gridLevels": 12
  },
  {
    "pair": "SHIB/USDT",
    "gridOrderSizeUsdt": 10,
    "profile": "smallcap",
    "gridLevels": 10
  }
]
```

**Auto-Calculated Settings by Pair:**

| Pair | Order | Profile | Levels | Range | SL% | TP Min | TP Max |
|------|-------|---------|--------|-------|-----|--------|--------|
| BTC | $50 | major | 15 | 2.5% | 2.0% | $0.25 | $2.00 |
| ETH | $40 | major | 15 | 2.5% | 2.0% | $0.20 | $1.60 |
| MATIC | $20 | midcap | 12 | 3.5% | 2.8% | $0.10 | $0.75 |
| SHIB | $10 | smallcap | 10 | 5.0% | 3.5% | $0.05 | $0.50 |

**Key Observations:**
1. Each pair gets appropriate volatility settings
2. TP targets scale with order size (BTC $50 vs SHIB $10)
3. Stable coins (BTC/ETH) have tighter SL (2.0%)
4. Volatile coin (SHIB) has wider SL (3.5%)
5. All use same order size approach, different grid counts

---

### Scenario 5: Increasing Risk After Wins

**Current Setup (Conservative):**
```json
{
  "pair": "BTC/USDT",
  "gridOrderSizeUsdt": 25,
  "gridLevels": 15,
  "stopLossPercent": 2.0
}
```

**After 3 Profitable Days - Increase Order Size:**

```json
{
  "pair": "BTC/USDT",
  "gridOrderSizeUsdt": 75  ← Triple the order size!
}
```

**Auto-Adjustment:**
```json
{
  "targetProfitMinUsdt": 0.50,   ← Was 0.125 (tripled)
  "targetProfitMaxUsdt": 2.00,   ← Was 1.00 (doubled)
  "gridLevels": 15,              ← Same (still major)
  "stopLossPercent": 2.0         ← Same risk %
}
```

**Effect:**
- Same risk percentage (2.0% SL)
- But now targeting $0.50-$2.00 per trade (3x bigger wins)
- Positions are 3x larger
- Grid structure stays the same

---

### Scenario 6: Emergency Risk Reduction

**Current Setup (During Loss Streak):**
```json
{
  "pair": "DOGE/USDT",
  "gridOrderSizeUsdt": 50,
  "stopLossPercent": 3.5,
  "gridLevels": 10
}
```

**After 2 Losses - Reduce to Minimum:**

```json
{
  "pair": "DOGE/USDT",
  "gridOrderSizeUsdt": 5  ← 10x reduction!
}
```

**Auto-Adjustment:**
```json
{
  "targetProfitMinUsdt": 0.025,  ← Was 0.25 (10x smaller)
  "targetProfitMaxUsdt": 0.20,   ← Was 2.00 (10x smaller)
  "gridLevels": 10,              ← Same
  "stopLossPercent": 3.5         ← Same
}
```

**Effect:**
- Reduced exposure by 90%
- Same grid structure
- Much smaller losses if trade goes wrong
- Can recover faster

---

### Scenario 7: Testing New Pair

**Goal**: Try trading LINK (new for you) with auto-config

**Initial Setup - Small Size:**
```json
{
  "pair": "LINK/USDT",
  "gridOrderSizeUsdt": 5
}
```

**System Analysis:**
1. LINK not in major list, not in common midcap list
2. Defaults to smallcap profile
3. Applies conservative smallcap settings

**Auto-Config Result:**
```json
{
  "gridLevels": 10,
  "gridRangePercent": 5.0,
  "stopLossPercent": 3.5,
  "targetProfitMinUsdt": 0.025,
  "targetProfitMaxUsdt": 0.20
}
```

**Testing Phase 1 (First 24 hours):**
- Monitor with $5 orders
- 10 grid levels, 5% range
- Observe actual behavior

**Testing Phase 2 (Next 24 hours):**
If working well:
```json
{
  "gridOrderSizeUsdt": 10  ← Double order size
}
```

Auto-calculates to: TP $0.05-$0.40 (2x)

**Testing Phase 3 (Full deployment):**
After 48 hours of successful trades:
```json
{
  "gridOrderSizeUsdt": 25  ← Full production size
}
```

Auto-calculates to: TP $0.125-$1.00 (5x from initial)

---

### Scenario 8: Manual Override (Advanced)

**Normal Auto-Config:**
```json
{
  "pair": "ADA/USDT",
  "gridOrderSizeUsdt": 30,
  "gridLevels": 12,          ← Auto-calculated
  "stopLossPercent": 2.8     ← Auto-calculated
}
```

**You Want More Aggressive Trading:**
```json
{
  "gridLevels": 20,          ← Override! (was 12)
  "stopLossPercent": 2.0     ← Override! (was 2.8)
}
```

**Result:**
- 20 grid levels (20 instead of 12)
- 2.0% SL (more aggressive)
- Other params still auto-calculated
- ⚠️ When you change pair again, overrides are ignored

**To Re-Enable Auto:**
Remove overrides and set back to auto values:
```json
{
  "gridLevels": 12,          ← Back to auto
  "stopLossPercent": 2.8     ← Back to auto
}
```

---

## Dashboard Configuration Examples

### Example API Call: Set New Pair

**PUT /api/config**
```json
{
  "pair": "BTC/USDT",
  "gridOrderSizeUsdt": 50
}
```

**Response:**
```json
{
  "ok": true,
  "config": {
    "pair": "BTC/USDT",
    "gridOrderSizeUsdt": 50,
    "gridLevels": 15,
    "gridRangePercent": 2.5,
    "stopLossPercent": 2.0,
    "targetProfitMinUsdt": 0.25,
    "targetProfitMaxUsdt": 2.0,
    "pairProfile": "major",
    "autoPairCalculated": true,
    "lastAutoCalculatedAt": 1716460800000
  }
}
```

### Example API Call: Switch Pairs

**PUT /api/config**
```json
{
  "pair": "DOGE/USDT"
}
```

**Response:**
```json
{
  "ok": true,
  "config": {
    "pair": "DOGE/USDT",
    "gridOrderSizeUsdt": 50,  ← Same as before
    "gridLevels": 10,         ← Auto-updated
    "gridRangePercent": 5.0,  ← Auto-updated
    "stopLossPercent": 3.5,   ← Auto-updated
    "targetProfitMinUsdt": 0.25,
    "targetProfitMaxUsdt": 2.0,
    "pairProfile": "smallcap", ← Different profile
    "autoPairCalculated": true,
    "lastAutoCalculatedAt": 1716460950000
  }
}
```

---

## Troubleshooting

### Problem: Parameters Didn't Update

**Check:**
1. Is pair set? (pair field not empty)
2. Is gridOrderSize > 0? (not zero)
3. Check logs for [CONFIG][INFO] messages

**Fix:**
```json
{
  "pair": "BTC/USDT",       // Must be set
  "gridOrderSizeUsdt": 50   // Must be > 0
}
```

### Problem: Same Order Size, Different Results

**This is Normal!**
- BTC/USDT with $50 → 15 grids, 2.0% SL
- SHIB/USDT with $50 → 10 grids, 3.5% SL

Different pairs have different volatility profiles → different auto-configs.

### Problem: Override Not Applying

**Remember:**
- Overrides only affect that parameter
- Other parameters still auto-calculate
- Overrides persist across pair changes (⚠️ may not be desired)

**Reset to Auto:**
1. Remove the override key
2. Set back to auto value
3. Re-save config

---

## Performance Notes

| Operation | Time | Frequency |
|-----------|------|-----------|
| Auto-calculate parameters | <1ms | Only when pair/order changes |
| Config save to DB | ~50ms | After auto-calc |
| Next trading cycle | Instant | Uses saved config |

**Total impact**: Negligible (only on config change, not every cycle)

---

## Best Practices

1. ✅ Start with small order sizes ($5-$10) for new pairs
2. ✅ Let auto-config run for 24+ hours before increasing
3. ✅ Scale up order size gradually (50% increases)
4. ✅ Use same pair/order size across sessions for consistency
5. ✅ Don't override parameters unless you have specific reason
6. ✅ Monitor logs for auto-calc events
7. ✅ Test pair switch during low-volume hours
8. ✅ Keep backup of working configurations

---

## Summary

**The Beauty of Pair Auto-Config:**
- Set pair: `BTC/USDT` ✓
- Set order: `$50` ✓
- Everything else: **Automatic!** ✓

Switch pairs, change order size, scale up/down → everything recalculates intelligently based on pair volatility.

No more manual TP/SL tuning per pair. The system handles it.

# Pair Auto-Config - Quick Reference

## TL;DR (Too Long; Didn't Read)

**Before (Manual):**
```
Set pair: BTC/USDT
Set gridOrderSize: $50
Manually set gridLevels: 15
Manually set gridRangePercent: 2.5%
Manually set stopLossPercent: 2.0%
Manually set targetProfitMinUsdt: $0.25
Manually set targetProfitMaxUsdt: $2.00
... repeat for each pair
```

**After (Auto):**
```
Set pair: BTC/USDT
Set gridOrderSize: $50
✓ Everything else auto-calculates!
```

---

## One-Minute Setup

### Step 1: Open Dashboard
Navigate to configuration section

### Step 2: Enter Two Values
```json
{
  "pair": "BTC/USDT",           // Your trading pair
  "gridOrderSizeUsdt": 50       // Your order size in dollars
}
```

### Step 3: Click Save
System auto-calculates 20+ parameters

### Step 4: Start Trading
Configuration is ready to use!

---

## Pair Categories (Auto-Detected)

| If You Trade | Category | Result |
|--------------|----------|--------|
| BTC, ETH, BNB, SOL | MAJOR | Conservative: 15 grids, 2.0% SL |
| ADA, MATIC, LINK, AVAX | MIDCAP | Moderate: 12 grids, 2.8% SL |
| SHIB, DOGE, New Alts | SMALLCAP | Aggressive: 10 grids, 3.5% SL |

---

## What Auto-Calculates

✅ **Grid Levels** → How many entry points  
✅ **Grid Range** → How spread out they are  
✅ **Take Profit** → Minimum and maximum profit targets  
✅ **Stop Loss** → Percentage to cut losses  
✅ **ATR Multipliers** → For trailing stop and risk sizing  
✅ **Risk Ratios** → Reward vs risk balance  
✅ **All Technical Params** → 20+ settings total  

---

## Changing Pairs

### Before: BTC
```json
{
  "pair": "BTC/USDT",
  "gridOrderSizeUsdt": 50,
  "gridLevels": 15,
  "gridRangePercent": 2.5,
  "stopLossPercent": 2.0
}
```

### Switch to DOGE
```json
{
  "pair": "DOGE/USDT",
  "gridOrderSizeUsdt": 50
}
```

### After: Auto-Updated
```json
{
  "pair": "DOGE/USDT",
  "gridOrderSizeUsdt": 50,
  "gridLevels": 10,        ← Auto-updated
  "gridRangePercent": 5.0, ← Auto-updated
  "stopLossPercent": 3.5   ← Auto-updated
}
```

---

## Scaling Order Size

### Before
```
Order: $50
TP Min: $0.25
TP Max: $2.00
```

### Double Order
```json
{ "gridOrderSizeUsdt": 100 }
```

### After
```
Order: $100 (2x)
TP Min: $0.50 (2x)
TP Max: $4.00 (2x)
```

✅ Targets scale proportionally with order size

---

## Real-World Example

### Day 1: Start with BTC
```json
{
  "pair": "BTC/USDT",
  "gridOrderSizeUsdt": 25
}
```
→ System calculates: 15 grids, 2% SL, $0.125-$1.25 TP

### Day 2: Feeling Profitable
```json
{
  "gridOrderSizeUsdt": 50  ← Just increase this
}
```
→ System auto-scales: $0.25-$2.50 TP (2x)

### Day 3: Try Altcoin
```json
{
  "pair": "MATIC/USDT"  ← Just change this
}
```
→ System auto-adjusts: 12 grids, 2.8% SL (midcap profile)

### Day 4: High Volatility Play
```json
{
  "pair": "SHIB/USDT"  ← Just change this
}
```
→ System auto-adjusts: 10 grids, 3.5% SL (smallcap profile)

**No manual parameter tuning needed!**

---

## API Endpoint

**Set Configuration:**
```
PUT /api/config
Content-Type: application/json

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
    "autoPairCalculated": true
  }
}
```

---

## Logs to Watch

```
[CONFIG][INFO] Auto-calculating parameters for pair BTC/USDT with order size $50.00
[CONFIG][INFO] Auto-calculated pair-specific parameters for BTC/USDT
```

If you see these → Auto-config worked! ✅

---

## Common Scenarios

### Scenario 1: New Pair
**Set:** `pair=LINK/USDT, gridOrderSize=$20`  
**Result:** Auto-config applies midcap profile

### Scenario 2: Scale Up  
**Change:** `gridOrderSize=$50` → `$100`  
**Result:** Profit targets 2x, SL% same

### Scenario 3: Scale Down (Risk Reduction)
**Change:** `gridOrderSize=$50` → `$10`  
**Result:** Profit targets 5x smaller, SL% same

### Scenario 4: All Stable Coins
**Trade:** BTC → ETH → BNB (all major)  
**Result:** Same settings (15 grids, 2% SL) for all!

### Scenario 5: Volatile Experiment
**Trade:** DOGE at low risk: `gridOrderSize=$5`  
**Result:** Mini positions (10 grids, 3.5% SL)

---

## Pro Tips

1. **Test new pairs with small size first**
   ```json
   { "gridOrderSize": 5 }  // Start here
   ```

2. **Scale gradually**
   ```json
   // Day 1
   { "gridOrderSize": 5 }
   // Day 2
   { "gridOrderSize": 10 }
   // Day 3
   { "gridOrderSize": 20 }
   ```

3. **Monitor the logs**
   ```
   Look for [CONFIG][INFO] messages after changes
   ```

4. **Use same order size across pairs**
   ```
   BTC: $50
   ETH: $50
   MATIC: $50
   SHIB: $50
   Same amount, different auto-configs
   ```

5. **Don't overthink it**
   - System handles volatility differences
   - You just set pair and size
   - Everything else is automatic

---

## Troubleshooting

| Problem | Solution |
|---------|----------|
| Parameters didn't update | Check: pair is set AND gridOrderSize > 0 |
| Same pair, different results | Normal - order size scales targets |
| Want manual control | Override specific parameter |
| Want auto back | Remove override |
| Check if it worked | Look for [CONFIG][INFO] logs |

---

## Supported Pairs

### Auto-Detected as MAJOR
- BTC/USDT
- ETH/USDT
- BNB/USDT
- SOL/USDT

### Auto-Detected as MIDCAP
- ADA/USDT
- XRP/USDT
- MATIC/USDT
- LINK/USDT
- AVAX/USDT
- LITECOIN/USDT
- ATOM/USDT

### Auto-Detected as SMALLCAP (Default)
- SHIB/USDT
- DOGE/USDT
- Any other pair

---

## Before & After

### Before Auto-Config
```
Time to configure new pair: 10-15 minutes
Manual steps: 20+
Risk of errors: High
Switching pairs: Very tedious
Scaling order size: Complex manual math
```

### After Auto-Config
```
Time to configure new pair: 1 minute
Manual steps: 2 (pair + order size)
Risk of errors: Near zero
Switching pairs: One click
Scaling order size: Just change the number
```

---

## Next Steps

1. Set your first pair with auto-config
2. Monitor logs for confirmation
3. Run 1-2 trading cycles
4. Verify results look good
5. Try switching pairs
6. Try scaling order size
7. Enjoy automated trading! 🚀

---

## Questions?

Check these docs:
- **PAIR_AUTO_CONFIG_GUIDE.md** → User guide
- **PAIR_AUTO_CONFIG_EXAMPLES.md** → Real examples
- **PAIR_AUTO_CONFIG_TECHNICAL.md** → Technical details
- **PAIR_AUTO_CONFIG_SUMMARY.md** → Full overview

---

## Summary

✅ Set 2 parameters (pair, order size)  
✅ Everything else auto-calculates  
✅ Intelligent per-pair profiles  
✅ Proportional scaling with order size  
✅ Switch pairs with one click  
✅ Stop manual tuning forever  

**That's it. You're done. Start trading.** 🎯

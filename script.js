#!/usr/bin/env python3
# -*- coding: utf-8 -*-

"""
Predictor BET261 Legendary - v3.1 (UPDATED)
- Rolling backtest (train past -> test future)
- Metrics: accuracy, logloss, Brier, reliability bins
- Abstain (NO BET) rules: min_neighbors, conf_min, ev_min
- Adaptive K based on #close neighbors under distance threshold
- Value betting EV with decimal odds: EV = p*odds - 1
- Bankroll simulation: flat or fractional Kelly

USAGE:
  python predictor_v3.py --csv data.csv --test_min_j 19 --test_max_j 40 --train_window 180 \
    --k_list 7,11,15,21,31,41 --conf_min 0.56 --min_neighbors 9 --dist_quantile 0.20 \
    --ev_min 0.02 --stake_mode flat --flat_stake 0.02 --bankroll0 1000 --debug 1

Notes:
- Time axis: 'journee' numeric
- Required for 1X2: odd_1, odd_x, odd_2, result
"""

import argparse
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, List, Tuple, Optional

import numpy as np
import pandas as pd


# -----------------------------
# Utilities: metrics
# -----------------------------
def safe_log(x: np.ndarray, eps: float = 1e-15) -> np.ndarray:
    return np.log(np.clip(x, eps, 1.0 - eps))

def multiclass_logloss(y_true_idx: np.ndarray, proba: np.ndarray) -> float:
    n = len(y_true_idx)
    p = proba[np.arange(n), y_true_idx]
    return float(-np.mean(safe_log(p)))

def accuracy(y_true_idx: np.ndarray, y_pred_idx: np.ndarray) -> float:
    return float(np.mean(y_true_idx == y_pred_idx))

def brier_score_multiclass(y_true_idx: np.ndarray, proba: np.ndarray) -> float:
    n, c = proba.shape
    y = np.zeros_like(proba)
    y[np.arange(n), y_true_idx] = 1.0
    return float(np.mean(np.sum((proba - y) ** 2, axis=1)))

def reliability_bins(y_true_idx: np.ndarray, proba: np.ndarray, n_bins: int = 10) -> pd.DataFrame:
    pred = np.argmax(proba, axis=1)
    conf = np.max(proba, axis=1)
    correct = (pred == y_true_idx).astype(int)

    bins = np.linspace(0.0, 1.0, n_bins + 1)
    rows = []
    for i in range(n_bins):
        lo, hi = bins[i], bins[i + 1]
        mask = (conf >= lo) & (conf < hi) if i < n_bins - 1 else (conf >= lo) & (conf <= hi)
        cnt = int(mask.sum())
        if cnt == 0:
            rows.append({"bin": f"{lo:.2f}-{hi:.2f}", "n": 0, "avg_conf": np.nan, "acc_in_bin": np.nan})
        else:
            rows.append({
                "bin": f"{lo:.2f}-{hi:.2f}",
                "n": cnt,
                "avg_conf": float(conf[mask].mean()),
                "acc_in_bin": float(correct[mask].mean())
            })
    return pd.DataFrame(rows)


# -----------------------------
# KNN core
# -----------------------------
@dataclass
class KNNConfig:
    k_list: List[int]
    dist_quantile: float
    min_neighbors: int
    conf_min: float
    temperature: float

def euclidean_distances(x: np.ndarray, X: np.ndarray) -> np.ndarray:
    # fast euclidean using (x - X)^2
    diff = X - x
    return np.sqrt(np.sum(diff * diff, axis=1))

def weighted_vote_probs(
    y_train_idx: np.ndarray,
    dists: np.ndarray,
    k: int,
    n_classes: int,
    temperature: float
) -> np.ndarray:
    """
    Weighted KNN probabilities:
      weights = exp(-dist / temperature)
    """
    k = int(max(1, k))
    idx = np.argpartition(dists, k - 1)[:k]  # faster than full sort
    d = dists[idx]

    t = max(1e-9, float(temperature))
    w = np.exp(-d / t)

    if (not np.isfinite(w).all()) or (w.sum() <= 1e-12):
        w = np.ones_like(w, dtype=float)

    probs = np.zeros(n_classes, dtype=float)
    for wi, yi in zip(w, y_train_idx[idx]):
        probs[int(yi)] += float(wi)

    s = probs.sum()
    if s <= 1e-12:
        return np.ones(n_classes, dtype=float) / n_classes
    return probs / s


# -----------------------------
# Feature engineering
# -----------------------------
def normalize_result(val: str) -> Optional[str]:
    if pd.isna(val):
        return None
    s = str(val).strip().upper()
    if s in ["1", "HOME", "H", "DOM", "D"]:
        return "1"
    if s in ["X", "DRAW", "NUL", "N"]:
        return "X"
    if s in ["2", "AWAY", "A", "EXT", "E"]:
        return "2"
    return None

def build_features(df: pd.DataFrame) -> Tuple[pd.DataFrame, List[str]]:
    """
    Features:
    - journee numeric
    - odd_* numeric columns
    - league/home/away categorical one-hot

    NOTE: 'result' not included in features.
    """
    df = df.copy()

    df["journee"] = pd.to_numeric(df["journee"], errors="coerce")

    odd_cols = [c for c in df.columns if c.lower().startswith("odd_")]
    for c in odd_cols:
        df[c] = pd.to_numeric(df[c], errors="coerce")

    cat_cols = [c for c in ["league", "home", "away"] if c in df.columns]
    num_cols = ["journee"] + odd_cols

    X_num = df[num_cols].copy()
    X_cat = pd.get_dummies(df[cat_cols].astype(str), prefix=cat_cols, dummy_na=False) if cat_cols else pd.DataFrame(index=df.index)

    X = pd.concat([X_num, X_cat], axis=1)
    feature_cols = list(X.columns)
    return X, feature_cols

def standardize_train_apply(X_train: np.ndarray, X_test: np.ndarray) -> Tuple[np.ndarray, np.ndarray]:
    mu = np.nanmean(X_train, axis=0)
    sigma = np.nanstd(X_train, axis=0)
    sigma = np.where(sigma < 1e-9, 1.0, sigma)

    X_train_s = (np.nan_to_num(X_train, nan=0.0) - mu) / sigma
    X_test_s = (np.nan_to_num(X_test, nan=0.0) - mu) / sigma
    return X_train_s, X_test_s


# -----------------------------
# Value betting + bankroll
# -----------------------------
def expected_value(prob: float, odds: float) -> float:
    if not np.isfinite(prob) or not np.isfinite(odds) or odds <= 1e-9:
        return -np.inf
    return float(prob * odds - 1.0)

def stake_fraction_kelly(p: float, odds: float) -> float:
    b = odds - 1.0
    if not np.isfinite(p) or not np.isfinite(odds) or b <= 1e-12:
        return 0.0
    f = (p * odds - 1.0) / b
    return float(max(0.0, f))

def simulate_bankroll(df_out: pd.DataFrame, bankroll0: float, stake_mode: str, flat_stake: float, kelly_fraction: float) -> pd.DataFrame:
    bankroll = float(bankroll0)
    history = []

    for i, row in df_out.iterrows():
        bet = bool(row["bet"])
        if not bet:
            history.append({"bankroll": bankroll, "stake": 0.0, "pnl": 0.0})
            continue

        odds = float(row["odds_pick"])
        p = float(row["proba_pick"])

        if stake_mode == "flat":
            stake = bankroll * float(flat_stake)
        else:  # kelly
            f = stake_fraction_kelly(p, odds)
            stake = bankroll * (float(kelly_fraction) * f)

        stake = float(max(0.0, stake))
        if stake <= 1e-12:
            history.append({"bankroll": bankroll, "stake": 0.0, "pnl": 0.0})
            continue

        win = (str(row["pick"]) == str(row["result"]))
        pnl = stake * (odds - 1.0) if win else -stake
        bankroll += pnl

        history.append({"bankroll": bankroll, "stake": stake, "pnl": pnl})

    return pd.DataFrame(history)


# -----------------------------
# Rolling backtest
# -----------------------------
def rolling_backtest(
    df: pd.DataFrame,
    test_min_j: int,
    test_max_j: int,
    train_window: int,
    cfg: KNNConfig,
    ev_min: float,
    debug: int,
    seed: int
) -> Tuple[pd.DataFrame, Dict[str, float], pd.DataFrame, pd.DataFrame]:
    classes = ["1", "X", "2"]
    class_to_idx = {c: i for i, c in enumerate(classes)}
    odds_map = {"1": "odd_1", "X": "odd_x", "2": "odd_2"}

    df = df.copy()
    df["result_norm"] = df["result"].apply(normalize_result)
    df = df[~df["result_norm"].isna()].copy()
    df["y_idx"] = df["result_norm"].map(class_to_idx).astype(int)
    df["journee"] = pd.to_numeric(df["journee"], errors="coerce")
    df = df.dropna(subset=["journee"]).copy()
    df["journee"] = df["journee"].astype(int)

    Xdf, feature_cols = build_features(df)
    Xdf = Xdf.fillna(np.nan)

    outputs = []

    all_proba = []
    all_y = []
    all_pred = []
    all_betmask = []

    dist_thresh_list = []

    rng = np.random.RandomState(seed)

    for j in range(test_min_j, test_max_j + 1):
        test_mask = (df["journee"] == j)
        if not test_mask.any():
            if debug >= 1:
                print(f"[BACKTEST] journee={j}: no rows -> skip")
            continue

        train_mask = (df["journee"] < j)
        if train_window and train_window > 0:
            train_mask = train_mask & (df["journee"] >= (j - train_window))

        df_train = df[train_mask].copy()
        df_test = df[test_mask].copy()

        if len(df_train) < max(cfg.k_list) + 5:
            if debug >= 1:
                print(f"[BACKTEST] journee={j}: train too small ({len(df_train)}) -> no-bet")
            for _, row in df_test.iterrows():
                outputs.append({
                    "journee": int(row["journee"]),
                    "league": row.get("league", ""),
                    "home": row.get("home", ""),
                    "away": row.get("away", ""),
                    "result": row["result_norm"],
                    "pick_pred": None,
                    "proba_pred": np.nan,
                    "odds_pred": np.nan,
                    "ev_pred": np.nan,
                    "bet": False,
                    "pick": None,
                    "proba_pick": np.nan,
                    "odds_pick": np.nan,
                    "ev": np.nan,
                    "reason": "train_too_small",
                    "k_used": np.nan,
                    "dist_thresh": np.nan,
                    "n_close": 0
                })
            continue

        X_train = Xdf.loc[df_train.index, feature_cols].to_numpy(dtype=float)
        X_test = Xdf.loc[df_test.index, feature_cols].to_numpy(dtype=float)

        X_train_s, X_test_s = standardize_train_apply(X_train, X_test)
        y_train_idx = df_train["y_idx"].to_numpy(dtype=int)

        # Distance threshold estimation using sample of train points
        k0 = min(max(cfg.k_list), len(df_train) - 1)
        sample_n = min(600, len(df_train))
        sample_idx = rng.choice(len(df_train), size=sample_n, replace=False)

        kth_dists = []
        for si in sample_idx:
            d = euclidean_distances(X_train_s[si], X_train_s)
            d[si] = np.inf
            kth = float(np.partition(d, k0 - 1)[k0 - 1])
            if np.isfinite(kth):
                kth_dists.append(kth)

        dist_thresh = float(np.quantile(np.array(kth_dists), cfg.dist_quantile)) if kth_dists else float("inf")
        dist_thresh_list.append(dist_thresh)

        if debug >= 1:
            print(f"\n[BACKTEST] journee={j} | train={len(df_train)} test={len(df_test)} | dist_thresh(q={cfg.dist_quantile})={dist_thresh:.4f}")

        # Predict each test row
        for (idx_row, row), x in zip(df_test.iterrows(), X_test_s):
            dists = euclidean_distances(x, X_train_s)
            n_close = int((dists <= dist_thresh).sum())

            feasible = [k for k in cfg.k_list if k <= n_close and k <= len(df_train)]
            k_used = max(feasible) if feasible else min(cfg.k_list)
            k_used = int(min(k_used, len(df_train)))

            proba = weighted_vote_probs(y_train_idx, dists, k_used, 3, cfg.temperature)
            pred_idx = int(np.argmax(proba))
            pick_pred = classes[pred_idx]
            proba_pred = float(proba[pred_idx])

            odd_col = odds_map[pick_pred]
            odds_pred = float(row.get(odd_col, np.nan))
            ev_pred = expected_value(proba_pred, odds_pred)

            # Decision rules
            if n_close < cfg.min_neighbors:
                bet = False
                reason = f"abstain_min_neighbors(n_close={n_close}<{cfg.min_neighbors})"
            elif proba_pred < cfg.conf_min:
                bet = False
                reason = f"abstain_low_conf(p={proba_pred:.3f}<{cfg.conf_min})"
            elif ev_pred < ev_min:
                bet = False
                reason = f"abstain_low_ev(ev={ev_pred:.3f}<{ev_min})"
            else:
                bet = True
                reason = "bet_ok"

            outputs.append({
                "journee": int(row["journee"]),
                "league": row.get("league", ""),
                "home": row.get("home", ""),
                "away": row.get("away", ""),
                "result": row["result_norm"],

                # Always store predictions (even NO BET)
                "pick_pred": pick_pred,
                "proba_pred": proba_pred,
                "odds_pred": odds_pred,
                "ev_pred": ev_pred,

                # Bet fields (only meaningful if bet=True)
                "bet": bool(bet),
                "pick": pick_pred if bet else None,
                "proba_pick": proba_pred if bet else np.nan,
                "odds_pick": odds_pred if bet else np.nan,
                "ev": ev_pred if bet else np.nan,

                "reason": reason,
                "k_used": int(k_used),
                "dist_thresh": float(dist_thresh),
                "n_close": int(n_close),

                "p1": float(proba[0]),
                "pX": float(proba[1]),
                "p2": float(proba[2]),
            })

            all_proba.append(proba)
            all_y.append(int(row["y_idx"]))
            all_pred.append(pred_idx)
            all_betmask.append(bool(bet))

            if debug >= 2:
                print(
                    f"  - {row.get('home','')} vs {row.get('away','')} | "
                    f"p=[{proba[0]:.3f},{proba[1]:.3f},{proba[2]:.3f}] "
                    f"pred={pick_pred} p={proba_pred:.3f} odds={odds_pred:.2f} ev={ev_pred:.3f} "
                    f"n_close={n_close} k={k_used} -> {reason}"
                )

    out_df = pd.DataFrame(outputs)

    # Metrics
    if len(all_proba) == 0:
        metrics = {"n_total": 0}
        return out_df, metrics, pd.DataFrame(), pd.DataFrame()

    P = np.vstack(all_proba)
    y = np.array(all_y, dtype=int)
    yhat = np.array(all_pred, dtype=int)
    betmask = np.array(all_betmask, dtype=bool)

    metrics = {
        "n_total": int(len(y)),
        "bet_rate": float(betmask.mean()),
        "accuracy_all": accuracy(y, yhat),
        "logloss_all": multiclass_logloss(y, P),
        "brier_all": brier_score_multiclass(y, P),
        "dist_thresh_mean": float(np.mean(dist_thresh_list)) if dist_thresh_list else np.nan,
        "dist_thresh_median": float(np.median(dist_thresh_list)) if dist_thresh_list else np.nan,
    }

    if betmask.any():
        metrics.update({
            "n_bets": int(betmask.sum()),
            "accuracy_bets": accuracy(y[betmask], yhat[betmask]),
            "logloss_bets": multiclass_logloss(y[betmask], P[betmask]),
            "brier_bets": brier_score_multiclass(y[betmask], P[betmask]),
        })
    else:
        metrics.update({
            "n_bets": 0,
            "accuracy_bets": np.nan,
            "logloss_bets": np.nan,
            "brier_bets": np.nan,
        })

    calib_all = reliability_bins(y, P, n_bins=10)
    calib_bets = reliability_bins(y[betmask], P[betmask], n_bins=10) if betmask.any() else pd.DataFrame()

    return out_df, metrics, calib_all, calib_bets


# -----------------------------
# Args + main
# -----------------------------
def parse_args():
    ap = argparse.ArgumentParser()

    ap.add_argument("--csv", type=str, required=True, help="Input CSV path")
    ap.add_argument("--out_csv", type=str, default="backtest_v3_output.csv", help="Output CSV path")

    ap.add_argument("--test_min_j", type=int, required=True)
    ap.add_argument("--test_max_j", type=int, required=True)
    ap.add_argument("--train_window", type=int, default=180)

    ap.add_argument("--k_list", type=str, default="7,11,15,21,31,41")
    ap.add_argument("--dist_quantile", type=float, default=0.20)
    ap.add_argument("--min_neighbors", type=int, default=9)
    ap.add_argument("--conf_min", type=float, default=0.56)
    ap.add_argument("--temperature", type=float, default=0.35)

    ap.add_argument("--ev_min", type=float, default=0.02)

    ap.add_argument("--stake_mode", type=str, default="flat", choices=["flat", "kelly"])
    ap.add_argument("--flat_stake", type=float, default=0.02)
    ap.add_argument("--kelly_fraction", type=float, default=0.25)

    ap.add_argument("--bankroll0", type=float, default=1000.0)
    ap.add_argument("--debug", type=int, default=1)
    ap.add_argument("--seed", type=int, default=42)

    return ap.parse_args()


def main():
    args = parse_args()

    csv_path = Path(args.csv)
    if not csv_path.exists():
        print(f"[ERROR] CSV not found: {args.csv}", file=sys.stderr)
        sys.exit(1)

    df = pd.read_csv(args.csv)

    required = ["journee", "odd_1", "odd_x", "odd_2", "result"]
    missing = [c for c in required if c not in df.columns]
    if missing:
        print(f"[ERROR] Missing required columns: {missing}", file=sys.stderr)
        print("[HINT] Mila: journee, odd_1, odd_x, odd_2, result", file=sys.stderr)
        sys.exit(1)

    # Clean
    df = df.copy()
    df["journee"] = pd.to_numeric(df["journee"], errors="coerce")
    for c in ["odd_1", "odd_x", "odd_2"]:
        df[c] = pd.to_numeric(df[c], errors="coerce")
    df = df.dropna(subset=["journee", "odd_1", "odd_x", "odd_2", "result"]).copy()

    k_list = [int(x.strip()) for x in str(args.k_list).split(",") if x.strip().isdigit()]
    k_list = sorted(list(set([k for k in k_list if k >= 1])))
    if not k_list:
        print("[ERROR] k_list invalid.", file=sys.stderr)
        sys.exit(1)

    cfg = KNNConfig(
        k_list=k_list,
        dist_quantile=float(args.dist_quantile),
        min_neighbors=int(args.min_neighbors),
        conf_min=float(args.conf_min),
        temperature=float(args.temperature),
    )

    if args.debug >= 1:
        print("=== Predictor BET261 Legendary v3.1 ===")
        print(f"[DATA] rows(clean)={len(df)} | test_j={args.test_min_j}->{args.test_max_j} | train_window={args.train_window}")
        print(f"[CFG] k_list={cfg.k_list} | dist_q={cfg.dist_quantile} | min_neighbors={cfg.min_neighbors} | conf_min={cfg.conf_min} | temp={cfg.temperature}")
        print(f"[VALUE] ev_min={args.ev_min}")
        print(f"[BANKROLL] mode={args.stake_mode} bankroll0={args.bankroll0} flat_stake={args.flat_stake} kelly_fraction={args.kelly_fraction}")
        print(f"[SEED] {args.seed}")

    out_df, metrics, calib_all, calib_bets = rolling_backtest(
        df=df,
        test_min_j=int(args.test_min_j),
        test_max_j=int(args.test_max_j),
        train_window=int(args.train_window),
        cfg=cfg,
        ev_min=float(args.ev_min),
        debug=int(args.debug),
        seed=int(args.seed),
    )

    sim_df = simulate_bankroll(
        df_out=out_df,
        bankroll0=float(args.bankroll0),
        stake_mode=str(args.stake_mode),
        flat_stake=float(args.flat_stake),
        kelly_fraction=float(args.kelly_fraction),
    )

    out_df = out_df.reset_index(drop=True)
    sim_df = sim_df.reset_index(drop=True)
    out_df["bankroll_after"] = sim_df["bankroll"]
    out_df["stake"] = sim_df["stake"]
    out_df["pnl"] = sim_df["pnl"]

    out_df.to_csv(args.out_csv, index=False)

    print("\n=== BACKTEST METRICS ===")
    for k, v in metrics.items():
        if isinstance(v, float):
            print(f"{k:>20s}: {v:.6f}")
        else:
            print(f"{k:>20s}: {v}")

    final_bankroll = float(out_df["bankroll_after"].dropna().iloc[-1]) if len(out_df) else float(args.bankroll0)
    total_bets = int(out_df["bet"].sum()) if "bet" in out_df.columns else 0
    total_pnl = float(out_df["pnl"].sum()) if "pnl" in out_df.columns else 0.0

    print("\n=== BANKROLL (PAPER) ===")
    print(f"{'total_bets':>20s}: {total_bets}")
    print(f"{'total_pnl':>20s}: {total_pnl:.3f}")
    print(f"{'final_bankroll':>20s}: {final_bankroll:.3f}")

    print("\n=== CALIBRATION (ALL) ===")
    print(calib_all.to_string(index=False) if not calib_all.empty else "No calibration data.")

    print("\n=== CALIBRATION (BETS ONLY) ===")
    print(calib_bets.to_string(index=False) if not calib_bets.empty else "No bets -> no calibration table.")

    print(f"\n[OK] Saved: {args.out_csv}")

    if args.debug >= 1 and len(out_df):
        cols = ["journee","home","away","result","pick_pred","proba_pred","odds_pred","ev_pred","bet","pick","proba_pick","odds_pick","ev","reason","k_used","n_close","bankroll_after"]
        cols = [c for c in cols if c in out_df.columns]
        print("\n=== SAMPLE (last 20) ===")
        print(out_df[cols].tail(20).to_string(index=False))


if __name__ == "__main__":
    main()

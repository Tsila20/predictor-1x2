#!/usr/bin/env python3
# -*- coding: utf-8 -*-

"""
Predictor BET261 Legendary - v3
- Rolling backtest (train on past -> test on future)
- Metrics: accuracy, logloss, Brier (calibration), reliability table
- Abstain rule (NO BET) if confidence low OR not enough close neighbors
- Adaptive K + distance threshold scanner
- Value betting via Expected Value (EV) using odds
- Bankroll simulation (paper trading)

USAGE (example):
  python predictor_v3.py --csv data.csv --test_min_j 19 --test_max_j 40 --train_window 180 \
    --k_list 7,11,15,21,31,41 --conf_min 0.56 --min_neighbors 9 --dist_quantile 0.20 \
    --ev_min 0.02 --stake_mode flat --flat_stake 0.02 --bankroll0 1000 --debug 1

Notes:
- Time axis = "journee" (must be numeric)
- Anti-leak: "result" excluded from features (only used as label)
"""

import argparse
import math
import sys
from dataclasses import dataclass
from typing import Dict, List, Tuple, Optional

import numpy as np
import pandas as pd


# -----------------------------
# Utilities: metrics
# -----------------------------
def safe_log(x: np.ndarray, eps: float = 1e-15) -> np.ndarray:
    return np.log(np.clip(x, eps, 1.0 - eps))

def multiclass_logloss(y_true_idx: np.ndarray, proba: np.ndarray) -> float:
    # y_true_idx: [0..C-1], proba: (n,C)
    n = len(y_true_idx)
    p = proba[np.arange(n), y_true_idx]
    return float(-np.mean(safe_log(p)))

def accuracy(y_true_idx: np.ndarray, y_pred_idx: np.ndarray) -> float:
    return float(np.mean(y_true_idx == y_pred_idx))

def brier_score_multiclass(y_true_idx: np.ndarray, proba: np.ndarray) -> float:
    # Brier for multiclass: mean(sum_c (p_c - y_c)^2)
    n, c = proba.shape
    y = np.zeros_like(proba)
    y[np.arange(n), y_true_idx] = 1.0
    return float(np.mean(np.sum((proba - y) ** 2, axis=1)))

def reliability_bins(
    y_true_idx: np.ndarray,
    proba: np.ndarray,
    n_bins: int = 10
) -> pd.DataFrame:
    """
    Calibration / reliability on predicted confidence of chosen class.
    - conf = max(prob)
    - correct = (argmax == y_true)
    Bins: [0,1]
    """
    pred = np.argmax(proba, axis=1)
    conf = np.max(proba, axis=1)
    correct = (pred == y_true_idx).astype(int)

    bins = np.linspace(0.0, 1.0, n_bins + 1)
    rows = []
    for i in range(n_bins):
        lo, hi = bins[i], bins[i+1]
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
# KNN core (manual)
# -----------------------------
@dataclass
class KNNConfig:
    k_list: List[int]
    dist_quantile: float     # quantile used to set distance threshold from train neighbor distances
    min_neighbors: int       # minimal close neighbors required to bet
    conf_min: float          # abstain if max prob below this
    temperature: float       # softmax temperature for distance->weight (lower = sharper)

def softmax(x: np.ndarray) -> np.ndarray:
    x = x - np.max(x)
    ex = np.exp(x)
    return ex / np.sum(ex)

def weighted_vote_probs(
    y_train_idx: np.ndarray,
    dists: np.ndarray,
    k: int,
    n_classes: int,
    temperature: float
) -> np.ndarray:
    """
    Take k nearest by distance, produce weighted class probabilities.
    weights = exp(-dist / temperature)
    """
    idx = np.argsort(dists)[:k]
    d = dists[idx]
    # Stabilize: if all distances huge, still ok.
    w = np.exp(-d / max(1e-9, temperature))
    # if weights are all ~0, fallback to uniform
    if not np.isfinite(w).all() or w.sum() <= 1e-12:
        w = np.ones_like(w, dtype=float)

    probs = np.zeros(n_classes, dtype=float)
    for wi, yi in zip(w, y_train_idx[idx]):
        probs[int(yi)] += float(wi)
    probs = probs / probs.sum()
    return probs

def euclidean_distances(x: np.ndarray, X: np.ndarray) -> np.ndarray:
    # x: (d,), X: (n,d) -> (n,)
    # Compute efficiently with broadcasting
    diff = X - x
    return np.sqrt(np.sum(diff * diff, axis=1))


# -----------------------------
# Feature engineering
# -----------------------------
def normalize_result(val: str) -> Optional[str]:
    if pd.isna(val):
        return None
    s = str(val).strip().upper()
    # accept variants
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
    - odds numeric columns (odd_*)
    - league/home/away as categorical (one-hot)
    - journee numeric
    IMPORTANT: do not include "result" in features.
    """
    df = df.copy()

    # Ensure numeric journee
    df["journee"] = pd.to_numeric(df["journee"], errors="coerce")

    # Collect odds columns
    odd_cols = [c for c in df.columns if c.lower().startswith("odd_")]
    for c in odd_cols:
        df[c] = pd.to_numeric(df[c], errors="coerce")

    cat_cols = [c for c in ["league", "home", "away"] if c in df.columns]
    num_cols = ["journee"] + odd_cols

    # One-hot categorical
    X_cat = pd.get_dummies(df[cat_cols].astype(str), prefix=cat_cols, dummy_na=False) if cat_cols else pd.DataFrame(index=df.index)
    X_num = df[num_cols].copy()

    X = pd.concat([X_num, X_cat], axis=1)

    feature_cols = list(X.columns)
    return X, feature_cols

def standardize_train_apply(
    X_train: np.ndarray,
    X_test: np.ndarray
) -> Tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    """
    Z-score standardization using train mean/std.
    Returns: X_train_s, X_test_s, mu, sigma
    """
    mu = np.nanmean(X_train, axis=0)
    sigma = np.nanstd(X_train, axis=0)
    sigma = np.where(sigma < 1e-9, 1.0, sigma)

    X_train_s = (np.nan_to_num(X_train, nan=0.0) - mu) / sigma
    X_test_s = (np.nan_to_num(X_test, nan=0.0) - mu) / sigma
    return X_train_s, X_test_s, mu, sigma


# -----------------------------
# Value betting + bankroll sim
# -----------------------------
def implied_prob_from_odds(odds: float) -> float:
    # naive implied probability = 1/odds
    if odds is None or not np.isfinite(odds) or odds <= 1e-9:
        return np.nan
    return 1.0 / odds

def expected_value(prob: float, odds: float) -> float:
    """
    EV for 1 unit stake with decimal odds:
    win: profit = (odds - 1)
    lose: profit = -1
    EV = p*(odds-1) + (1-p)*(-1) = p*odds - 1
    """
    if not np.isfinite(prob) or not np.isfinite(odds) or odds <= 1e-9:
        return -np.inf
    return prob * odds - 1.0

def stake_fraction_kelly(p: float, odds: float) -> float:
    """
    Kelly fraction for decimal odds:
    b = odds - 1
    f* = (p*b - (1-p)) / b = (p*odds - 1)/(odds-1)
    """
    b = odds - 1.0
    if not np.isfinite(p) or not np.isfinite(odds) or b <= 1e-12:
        return 0.0
    f = (p * odds - 1.0) / b
    return float(max(0.0, f))

def simulate_bankroll(
    df_bets: pd.DataFrame,
    bankroll0: float,
    stake_mode: str,
    flat_stake: float,
    kelly_fraction: float
) -> pd.DataFrame:
    """
    df_bets columns required:
      - bet (bool)
      - pick ("1","X","2")
      - proba_pick (float)
      - odds_pick (float)
      - result ("1","X","2")
    """
    bankroll = bankroll0
    history = []

    for i, row in df_bets.iterrows():
        bet = bool(row["bet"])
        if not bet:
            history.append({"i": i, "bankroll": bankroll, "stake": 0.0, "pnl": 0.0, "bet": False})
            continue

        odds = float(row["odds_pick"])
        p = float(row["proba_pick"])

        if stake_mode == "flat":
            stake = bankroll * flat_stake
        elif stake_mode == "kelly":
            f = stake_fraction_kelly(p, odds)
            stake = bankroll * (kelly_fraction * f)
        else:
            stake = bankroll * flat_stake

        stake = float(max(0.0, stake))
        if stake <= 1e-12:
            history.append({"i": i, "bankroll": bankroll, "stake": 0.0, "pnl": 0.0, "bet": False})
            continue

        win = (str(row["pick"]) == str(row["result"]))
        pnl = stake * (odds - 1.0) if win else -stake
        bankroll = bankroll + pnl

        history.append({"i": i, "bankroll": bankroll, "stake": stake, "pnl": pnl, "bet": True})

    return pd.DataFrame(history)


# -----------------------------
# Main rolling backtest
# -----------------------------
def rolling_backtest(
    df: pd.DataFrame,
    test_min_j: int,
    test_max_j: int,
    train_window: int,
    cfg: KNNConfig,
    ev_min: float,
    debug: int
) -> Tuple[pd.DataFrame, Dict[str, float], pd.DataFrame]:
    """
    For each journee in [test_min_j, test_max_j]:
      train = rows with journee < j and >= j-train_window (if train_window>0)
      test  = rows with journee == j
    Predict each row with adaptive K + distance threshold + abstain rule.
    """

    # Label mapping
    classes = ["1", "X", "2"]
    class_to_idx = {c: i for i, c in enumerate(classes)}

    # Clean result
    df = df.copy()
    df["result_norm"] = df["result"].apply(normalize_result) if "result" in df.columns else None
    df = df[~df["result_norm"].isna()].copy()
    df["y_idx"] = df["result_norm"].map(class_to_idx).astype(int)

    # Features
    Xdf, feature_cols = build_features(df)

    # Remove any remaining Na in feature rows: keep rows but will be nan_to_num later
    # Ensure consistent column order
    Xdf = Xdf.fillna(np.nan)

    outputs = []
    all_proba = []
    all_y = []
    all_pred = []
    all_covered_mask = []

    # For reporting distance threshold:
    global_dist_thresh_list = []

    for j in range(test_min_j, test_max_j + 1):
        test_mask = (df["journee"] == j)
        if not test_mask.any():
            if debug >= 1:
                print(f"[BACKTEST] journee={j}: no rows -> skip")
            continue

        # Train set strictly before journee j
        train_mask = (df["journee"] < j)
        if train_window and train_window > 0:
            train_mask = train_mask & (df["journee"] >= (j - train_window))

        df_train = df[train_mask].copy()
        df_test = df[test_mask].copy()

        if len(df_train) < max(cfg.k_list) + 5:
            if debug >= 1:
                print(f"[BACKTEST] journee={j}: train too small ({len(df_train)}) -> abstain all")
            for _, row in df_test.iterrows():
                outputs.append({
                    "journee": int(row["journee"]),
                    "league": row.get("league", ""),
                    "home": row.get("home", ""),
                    "away": row.get("away", ""),
                    "result": row["result_norm"],
                    "pick": None,
                    "proba_pick": np.nan,
                    "odds_pick": np.nan,
                    "ev": np.nan,
                    "bet": False,
                    "reason": "train_too_small",
                    "k_used": np.nan,
                    "dist_thresh": np.nan,
                    "n_close": 0
                })
            continue

        # Align features for train/test
        X_train = Xdf.loc[df_train.index, feature_cols].to_numpy(dtype=float)
        X_test = Xdf.loc[df_test.index, feature_cols].to_numpy(dtype=float)

        X_train_s, X_test_s, mu, sigma = standardize_train_apply(X_train, X_test)

        y_train_idx = df_train["y_idx"].to_numpy(dtype=int)

        # Distance threshold estimation:
        # compute for a sample of train points: distance to their k0-th neighbor
        k0 = min(max(cfg.k_list), len(df_train) - 1)
        sample_n = min(600, len(df_train))
        sample_idx = np.random.RandomState(42 + j).choice(len(df_train), size=sample_n, replace=False)

        kth_dists = []
        for si in sample_idx:
            d = euclidean_distances(X_train_s[si], X_train_s)
            d[si] = np.inf
            kth = np.partition(d, k0 - 1)[k0 - 1]
            if np.isfinite(kth):
                kth_dists.append(float(kth))
        if len(kth_dists) == 0:
            dist_thresh = np.inf
        else:
            dist_thresh = float(np.quantile(np.array(kth_dists), cfg.dist_quantile))
        global_dist_thresh_list.append(dist_thresh)

        if debug >= 1:
            print(f"\n[BACKTEST] journee={j} | train={len(df_train)} test={len(df_test)} | dist_thresh(q={cfg.dist_quantile})={dist_thresh:.4f}")

        # Predict each test row
        for (idx_row, row), x in zip(df_test.iterrows(), X_test_s):
            dists = euclidean_distances(x, X_train_s)

            # Count close neighbors under threshold
            close_mask = (dists <= dist_thresh)
            n_close = int(close_mask.sum())

            # Adaptive K: choose max K in k_list that is <= n_close (and <= train size)
            feasible_ks = [k for k in cfg.k_list if k <= n_close and k <= len(df_train)]
            if len(feasible_ks) == 0:
                # fallback: maybe use smallest k if at least k exists by distance ranking, else abstain
                k_used = min(cfg.k_list)
                if k_used > len(df_train):
                    k_used = len(df_train)
                # but mark as not enough close neighbors
                proba = weighted_vote_probs(y_train_idx, dists, k_used, 3, cfg.temperature)
                reason = f"abstain_not_enough_close(n_close={n_close})"
                bet = False
            else:
                k_used = max(feasible_ks)
                proba = weighted_vote_probs(y_train_idx, dists, k_used, 3, cfg.temperature)

                # Confidence rule
                conf = float(np.max(proba))
                pred_idx = int(np.argmax(proba))
                pick = classes[pred_idx]

                # Odds for pick
                odd_col = {"1": "odd_1", "X": "odd_x", "2": "odd_2"}.get(pick)
                odds_pick = float(row.get(odd_col, np.nan)) if odd_col else np.nan

                # Value betting EV rule
                ev = expected_value(conf, odds_pick)  # using conf as p (simple)
                # you can also use proba[pred_idx] explicitly; here conf==that.

                # Abstain conditions
                if n_close < cfg.min_neighbors:
                    bet = False
                    reason = f"abstain_min_neighbors(n_close={n_close}<{cfg.min_neighbors})"
                elif conf < cfg.conf_min:
                    bet = False
                    reason = f"abstain_low_conf(conf={conf:.3f}<{cfg.conf_min})"
                elif ev < ev_min:
                    bet = False
                    reason = f"abstain_low_ev(ev={ev:.3f}<{ev_min})"
                else:
                    bet = True
                    reason = "bet_ok"

            pred_idx = int(np.argmax(proba))
            pick = classes[pred_idx]
            conf = float(np.max(proba))
            odd_col = {"1": "odd_1", "X": "odd_x", "2": "odd_2"}.get(pick)
            odds_pick = float(row.get(odd_col, np.nan)) if odd_col else np.nan
            ev = expected_value(conf, odds_pick)

            outputs.append({
                "journee": int(row["journee"]),
                "league": row.get("league", ""),
                "home": row.get("home", ""),
                "away": row.get("away", ""),
                "result": row["result_norm"],
                "pick": pick if bet else None,
                "proba_pick": conf if bet else np.nan,
                "odds_pick": odds_pick if bet else np.nan,
                "ev": ev if bet else np.nan,
                "bet": bool(bet),
                "reason": reason,
                "k_used": int(k_used) if np.isfinite(k_used) else np.nan,
                "dist_thresh": dist_thresh,
                "n_close": n_close,
                "p1": float(proba[0]),
                "pX": float(proba[1]),
                "p2": float(proba[2]),
            })

            # For global metrics (predict-all, not only bet)
            all_proba.append(proba)
            all_y.append(int(row["y_idx"]))
            all_pred.append(pred_idx)
            all_covered_mask.append(bool(bet))

            if debug >= 2:
                print(
                    f"  - {row.get('home','')} vs {row.get('away','')} | "
                    f"p=[{proba[0]:.3f},{proba[1]:.3f},{proba[2]:.3f}] "
                    f"pick={pick} conf={conf:.3f} odds={odds_pick:.2f} ev={ev:.3f} "
                    f"n_close={n_close} k={k_used} -> {reason}"
                )

    out_df = pd.DataFrame(outputs)
    if len(all_proba) == 0:
        metrics = {"n": 0}
        calib = pd.DataFrame()
        return out_df, metrics, calib

    P = np.vstack(all_proba)
    y = np.array(all_y, dtype=int)
    yhat = np.array(all_pred, dtype=int)
    covered = np.array(all_covered_mask, dtype=bool)

    metrics = {
        "n_total": int(len(y)),
        "coverage_bet_rate": float(np.mean(covered)),
        "accuracy_all": accuracy(y, yhat),
        "logloss_all": multiclass_logloss(y, P),
        "brier_all": brier_score_multiclass(y, P),
    }

    # Metrics on bet-only subset
    if covered.any():
        metrics.update({
            "n_bets": int(covered.sum()),
            "accuracy_bets": accuracy(y[covered], yhat[covered]),
            "logloss_bets": multiclass_logloss(y[covered], P[covered]),
            "brier_bets": brier_score_multiclass(y[covered], P[covered]),
        })
    else:
        metrics.update({
            "n_bets": 0,
            "accuracy_bets": np.nan,
            "logloss_bets": np.nan,
            "brier_bets": np.nan,
        })

    calib = reliability_bins(y, P, n_bins=10)

    # Add summary dist threshold stats
    if len(global_dist_thresh_list) > 0:
        metrics["dist_thresh_mean"] = float(np.mean(global_dist_thresh_list))
        metrics["dist_thresh_median"] = float(np.median(global_dist_thresh_list))

    return out_df, metrics, calib


# -----------------------------
# I/O + main
# -----------------------------
def parse_args():
    ap = argparse.ArgumentParser()
    ap.add_argument("--csv", type=str, required=True, help="Input CSV path")
    ap.add_argument("--out_csv", type=str, default="backtest_v3_output.csv", help="Output CSV path")

    ap.add_argument("--test_min_j", type=int, required=True, help="Test start journee (inclusive)")
    ap.add_argument("--test_max_j", type=int, required=True, help="Test end journee (inclusive)")
    ap.add_argument("--train_window", type=int, default=180, help="Train window size in journee units (0=no window)")

    ap.add_argument("--k_list", type=str, default="7,11,15,21,31,41", help="Comma-separated K candidates")
    ap.add_argument("--dist_quantile", type=float, default=0.20, help="Quantile for distance threshold (lower=more strict)")
    ap.add_argument("--min_neighbors", type=int, default=9, help="Minimum close neighbors required to allow betting")
    ap.add_argument("--conf_min", type=float, default=0.56, help="Minimum confidence to bet")
    ap.add_argument("--temperature", type=float, default=0.35, help="Distance weight temperature")

    ap.add_argument("--ev_min", type=float, default=0.02, help="Minimum EV to bet (e.g. 0.02 = +2%)")

    ap.add_argument("--stake_mode", type=str, default="flat", choices=["flat", "kelly"], help="Bankroll staking mode")
    ap.add_argument("--flat_stake", type=float, default=0.02, help="Flat stake fraction of bankroll (e.g. 0.02=2%)")
    ap.add_argument("--kelly_fraction", type=float, default=0.25, help="Fractional Kelly multiplier (e.g. 0.25)")

    ap.add_argument("--bankroll0", type=float, default=1000.0, help="Starting bankroll for simulation")
    ap.add_argument("--debug", type=int, default=1, help="0=quiet,1=summary,2=per-match")

    return ap.parse_args()


def main():
    args = parse_args()

    # Load
    df = pd.read_csv(args.csv)
    # Basic cleaning: drop NA rows on required fields
    required = ["journee", "odd_1", "odd_x", "odd_2", "result"]
    missing = [c for c in required if c not in df.columns]
    if missing:
        print(f"[ERROR] Missing required columns: {missing}", file=sys.stderr)
        sys.exit(1)

    # Remove rows with NA odds or journee or result
    for c in ["journee", "odd_1", "odd_x", "odd_2", "result"]:
        df = df[~df[c].isna()].copy()

    # Anti-leak: ensure "result" is not used in feature creation (handled in build_features)
    # Ensure numeric odds
    for c in [col for col in df.columns if col.lower().startswith("odd_")]:
        df[c] = pd.to_numeric(df[c], errors="coerce")
    df = df.dropna(subset=["odd_1", "odd_x", "odd_2", "journee", "result"]).copy()

    k_list = [int(x.strip()) for x in args.k_list.split(",") if x.strip()]
    k_list = sorted(list(set([k for k in k_list if k >= 1])))

    cfg = KNNConfig(
        k_list=k_list,
        dist_quantile=float(args.dist_quantile),
        min_neighbors=int(args.min_neighbors),
        conf_min=float(args.conf_min),
        temperature=float(args.temperature),
    )

    if args.debug >= 1:
        print("=== Predictor BET261 Legendary v3 ===")
        print(f"[DATA] rows(clean)={len(df)} | test_j={args.test_min_j}->{args.test_max_j} | train_window={args.train_window}")
        print(f"[CFG] k_list={cfg.k_list} | dist_q={cfg.dist_quantile} | min_neighbors={cfg.min_neighbors} | conf_min={cfg.conf_min} | temp={cfg.temperature}")
        print(f"[VALUE] ev_min={args.ev_min}")
        print(f"[BANKROLL] mode={args.stake_mode} bankroll0={args.bankroll0} flat_stake={args.flat_stake} kelly_fraction={args.kelly_fraction}")

    out_df, metrics, calib = rolling_backtest(
        df=df,
        test_min_j=args.test_min_j,
        test_max_j=args.test_max_j,
        train_window=args.train_window,
        cfg=cfg,
        ev_min=float(args.ev_min),
        debug=int(args.debug),
    )

    # Bankroll sim on bets only (but we keep no-bet rows for timeline)
    sim_df = simulate_bankroll(
        df_bets=out_df,
        bankroll0=float(args.bankroll0),
        stake_mode=str(args.stake_mode),
        flat_stake=float(args.flat_stake),
        kelly_fraction=float(args.kelly_fraction),
    )

    # Merge sim history
    out_df = out_df.reset_index(drop=True)
    sim_df = sim_df.reset_index(drop=True)
    out_df["bankroll_after"] = sim_df["bankroll"]
    out_df["stake"] = sim_df["stake"]
    out_df["pnl"] = sim_df["pnl"]

    # Save
    out_df.to_csv(args.out_csv, index=False)

    # Print metrics
    print("\n=== BACKTEST METRICS ===")
    for k, v in metrics.items():
        if isinstance(v, float):
            print(f"{k:>20s}: {v:.6f}")
        else:
            print(f"{k:>20s}: {v}")

    # Basic bankroll summary
    final_bankroll = float(out_df["bankroll_after"].dropna().iloc[-1]) if len(out_df) else float(args.bankroll0)
    total_bets = int(out_df["bet"].sum()) if "bet" in out_df.columns else 0
    total_pnl = float(out_df["pnl"].sum()) if "pnl" in out_df.columns else 0.0
    print("\n=== BANKROLL (PAPER) ===")
    print(f"{'total_bets':>20s}: {total_bets}")
    print(f"{'total_pnl':>20s}: {total_pnl:.3f}")
    print(f"{'final_bankroll':>20s}: {final_bankroll:.3f}")

    # Print calibration table
    print("\n=== CALIBRATION (reliability bins) ===")
    if calib is None or calib.empty:
        print("No calibration data.")
    else:
        print(calib.to_string(index=False))

    print(f"\n[OK] Saved: {args.out_csv}")
    if args.debug >= 1:
        # Show top 20 debug lines of decisions
        print("\n=== SAMPLE DECISIONS (last 20) ===")
        cols = ["journee", "home", "away", "result", "pick", "proba_pick", "odds_pick", "ev", "bet", "reason", "k_used", "n_close", "bankroll_after"]
        cols = [c for c in cols if c in out_df.columns]
        print(out_df[cols].tail(20).to_string(index=False))


if __name__ == "__main__":
    main()

import json
import numpy as np
import pandas as pd
from sklearn.linear_model import LogisticRegression
from sklearn.preprocessing import StandardScaler
from sklearn.pipeline import Pipeline

# Expected CSV columns:
# league,journee,home,away,odd_1,odd_x,odd_2,result

def implied_probs(o1, ox, o2):
    inv = np.array([1.0/o1, 1.0/ox, 1.0/o2])
    return inv / inv.sum()

def compute_elo(df):
    K = 18
    base = 1500
    teams = pd.unique(df[['home','away']].values.ravel())
    rating = {t: base for t in teams}

    def expected(ra, rb):
        return 1/(1+10**((rb-ra)/400))

    for _, r in df.iterrows():
        h,a = r['home'], r['away']
        eh = expected(rating[h], rating[a])

        if r['result'] == '1':
            sh = 1
        elif r['result'] == '2':
            sh = 0
        else:
            sh = 0.5

        rating[h] += K*(sh-eh)
        rating[a] += K*((1-sh)-(1-eh))

    return rating

def build_data(df, rating):
    X,y = [],[]
    for _,r in df.iterrows():
        o1,ox,o2 = r['odd_1'],r['odd_x'],r['odd_2']
        pm = implied_probs(o1,ox,o2)

        elo_diff = rating[r['home']] - rating[r['away']]

        feats = [
            pm[0],pm[1],pm[2],
            np.log(o1),np.log(ox),np.log(o2),
            elo_diff
        ]
        X.append(feats)

        if r['result']=='1': y.append(0)
        elif r['result']=='X': y.append(1)
        else: y.append(2)

    return np.array(X), np.array(y)

def main():
    df = pd.read_csv("data/dataset.csv")
    df = df.dropna()

    rating = compute_elo(df)
    X,y = build_data(df,rating)

    pipe = Pipeline([
        ("scaler",StandardScaler()),
        ("clf",LogisticRegression(max_iter=2000,multi_class="multinomial"))
    ])

    pipe.fit(X,y)

    scaler = pipe.named_steps["scaler"]
    clf = pipe.named_steps["clf"]

    params = {
        "mean": scaler.mean_.tolist(),
        "scale": scaler.scale_.tolist(),
        "W": clf.coef_.tolist(),
        "b": clf.intercept_.tolist(),
        "classes": ["1","X","2"]
    }

    with open("model_params.json","w") as f:
        json.dump(params,f,indent=2)

    print("Model exported -> model_params.json")

if __name__ == "__main__":
    main()

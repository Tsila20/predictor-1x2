import pandas as pd
from sklearn.model_selection import train_test_split
from sklearn.ensemble import RandomForestClassifier

# Load dataset
df = pd.read_csv("data/france_virtual_league.csv")

# Atao target 1X2
def get_result(row):
    home_goals = int(row["result"].split("-")[0])
    away_goals = int(row["result"].split("-")[1])
    
    if home_goals > away_goals:
        return "1"
    elif home_goals < away_goals:
        return "2"
    else:
        return "X"

df["result_1x2"] = df.apply(get_result, axis=1)

# Features
X = df[["odd_1","odd_x","odd_2","odd_g","odd_ng"]]
y = df["result_1x2"]

# Split
X_train, X_test, y_train, y_test = train_test_split(X,y,test_size=0.2)

# Model
model = RandomForestClassifier()
model.fit(X_train,y_train)

print("Accuracy:", model.score(X_test,y_test))

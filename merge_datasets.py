import pandas as pd
import os

# Path raw data
raw_path = "data/raw"

# Maka fichiers rehetra
files = [f for f in os.listdir(raw_path) if f.endswith(".csv")]

# Lisitra hitahirizana data
df_list = []

for file in files:
    path = os.path.join(raw_path, file)
    df = pd.read_csv(path)
    df_list.append(df)

# Manambatra
full_df = pd.concat(df_list, ignore_index=True)

# Mamorona dossier processed raha tsy misy
os.makedirs("data/processed", exist_ok=True)

# Save
full_df.to_csv("data/processed/full_dataset.csv", index=False)

print("Merge completed successfully.")
print("Total matches:", len(full_df))

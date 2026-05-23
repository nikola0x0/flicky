import json

with open("pkg.json") as f:
    data = json.load(f)

content = data.get("content", {})
disassembled = content.get("disassembled", {})

if "oracle" in disassembled:
    print("\n================ Module: oracle ================")
    lines = disassembled["oracle"].split("\n")
    for line in lines:
        if any(k in line for k in [" public ", " entry ", " fun ", "struct ", "module "]) or line.strip().startswith("public") or line.strip().startswith("entry") or line.strip().startswith("fun"):
            print(line.strip())

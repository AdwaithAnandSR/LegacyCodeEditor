import sys

file_path = "/root/home/LegacyCodeEditor/src/app/index.tsx"
with open(file_path, "r") as f:
    lines = f.readlines()

out_lines = []
skip_link = False
for line in lines:
    if "import { Link } from \"expo-router\";" in line:
        if not skip_link:
            out_lines.append(line)
            skip_link = True
    elif "docsButton:" in line or "docsButtonText:" in line:
        continue
    elif "title: { fontSize: 22" in line:
        out_lines.append(line)
        out_lines.append('  docsButton: { backgroundColor: "#e3f2fd", paddingHorizontal: 16, paddingVertical: 8, borderRadius: 20, marginBottom: 16, alignSelf: "center" },\n')
        out_lines.append('  docsButtonText: { color: "#1976d2", fontWeight: "600", fontSize: 14 },\n')
    else:
        out_lines.append(line)

with open(file_path, "w") as f:
    f.writelines(out_lines)


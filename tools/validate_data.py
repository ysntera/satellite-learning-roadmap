"""
data/ の YAML ファイルに矛盾がないかを検査するスクリプト。

使い方（リポジトリのフォルダで）:
    py tools/validate_data.py        （Windows）
    python tools/validate_data.py    （GitHub Actions など）

検査すること
  1. 必須項目があるか
  2. field / stage / level が決められた値か
  3. prerequisites・books・next が、存在する id を指しているか
  4. 矢印（前提・読む順）が輪になっていないか（A→B→A のような循環）
問題があれば内容を表示して、終了コード 1 で終わる（Actions ではデプロイが止まる）。
"""
import sys
from pathlib import Path

import yaml

DATA_DIR = Path(__file__).resolve().parent.parent / "data"

SKILL_STAGES = {"basic", "applied", "practice"}
BOOK_LEVELS = {"intro", "basic", "advanced"}
SKILL_REQUIRED = ["id", "title", "field", "stage", "summary", "purpose", "learn", "goal"]
BOOK_REQUIRED = ["id", "title", "author", "publisher", "url", "field", "level"]


def load_yaml(file_name):
    path = DATA_DIR / file_name
    with open(path, encoding="utf-8") as f:
        data = yaml.safe_load(f)
    if not isinstance(data, list):
        raise SystemExit(f"{file_name}：中身がリスト（- で始まる項目の並び）になっていません")
    return data


def check_required(items, required, file_name, errors):
    for item in items:
        for key in required:
            if not item.get(key):
                errors.append(f"{file_name}：{item.get('id', '(id なし)')} に {key} がありません")


def check_unique(items, file_name, errors):
    seen = set()
    for item in items:
        item_id = item.get("id")
        if item_id in seen:
            errors.append(f"{file_name}：id「{item_id}」が重複しています")
        seen.add(item_id)
    return seen


def find_cycle(items, edge_key):
    """edge_key（prerequisites や next）でつないだときに輪があれば、その道すじを返す"""
    graph = {item["id"]: item.get(edge_key) or [] for item in items}
    WHITE, GRAY, BLACK = 0, 1, 2
    color = {node_id: WHITE for node_id in graph}
    path = []

    def visit(node_id):
        color[node_id] = GRAY
        path.append(node_id)
        for next_id in graph.get(node_id, []):
            if next_id not in graph:
                continue
            if color[next_id] == GRAY:
                return path[path.index(next_id):] + [next_id]
            if color[next_id] == WHITE:
                found = visit(next_id)
                if found:
                    return found
        path.pop()
        color[node_id] = BLACK
        return None

    for node_id in graph:
        if color[node_id] == WHITE:
            found = visit(node_id)
            if found:
                return found
    return None


def main():
    errors = []
    tracks = load_yaml("tracks.yaml")
    skills = load_yaml("nodes.yaml")
    books = load_yaml("books.yaml")

    track_ids = check_unique(tracks, "tracks.yaml", errors)
    skill_ids = check_unique(skills, "nodes.yaml", errors)
    book_ids = check_unique(books, "books.yaml", errors)

    check_required(skills, SKILL_REQUIRED, "nodes.yaml", errors)
    check_required(books, BOOK_REQUIRED, "books.yaml", errors)

    for skill in skills:
        sid = skill.get("id")
        if skill.get("field") not in track_ids:
            errors.append(f"nodes.yaml：{sid} の field「{skill.get('field')}」は tracks.yaml にありません")
        if skill.get("stage") not in SKILL_STAGES:
            errors.append(f"nodes.yaml：{sid} の stage は {sorted(SKILL_STAGES)} のどれかにしてください")
        for pre in skill.get("prerequisites") or []:
            if pre not in skill_ids:
                errors.append(f"nodes.yaml：{sid} の prerequisites「{pre}」というスキルはありません")
        for book in skill.get("books") or []:
            if book not in book_ids:
                errors.append(f"nodes.yaml：{sid} の books「{book}」は books.yaml にありません")

    for book in books:
        bid = book.get("id")
        if book.get("field") not in track_ids:
            errors.append(f"books.yaml：{bid} の field「{book.get('field')}」は tracks.yaml にありません")
        if book.get("level") not in BOOK_LEVELS:
            errors.append(f"books.yaml：{bid} の level は {sorted(BOOK_LEVELS)} のどれかにしてください")
        if not str(book.get("url", "")).startswith(("http://", "https://")):
            errors.append(f"books.yaml：{bid} の url が http で始まっていません")
        for nxt in book.get("next") or []:
            if nxt not in book_ids:
                errors.append(f"books.yaml：{bid} の next「{nxt}」は books.yaml にありません")

    process = load_yaml("process.yaml")
    for step in process:
        if not step.get("name"):
            errors.append("process.yaml：name のない工程があります")
        for field in step.get("fields") or []:
            if field not in track_ids:
                errors.append(f"process.yaml：{step.get('name')} の fields「{field}」は tracks.yaml にありません")

    cycle = find_cycle(skills, "prerequisites")
    if cycle:
        errors.append("nodes.yaml：前提が輪になっています → " + " → ".join(cycle))
    cycle = find_cycle(books, "next")
    if cycle:
        errors.append("books.yaml：読む順が輪になっています → " + " → ".join(cycle))

    if errors:
        print(f"問題が {len(errors)} 件あります：")
        for message in errors:
            print("  - " + message)
        sys.exit(1)
    print(f"OK：分野 {len(tracks)}、スキル {len(skills)}、本・資料 {len(books)} に問題はありません")


if __name__ == "__main__":
    main()

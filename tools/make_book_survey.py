"""分野ごとに「どの本が必要か」を答える質問票（Markdown）を作るスクリプト。

data/tracks.yaml・nodes.yaml・books.yaml を読み、分野ごとに
  1. いま載っている本（必要度・コメントを書き込む欄つき）
  2. 本がまだないスキル
  3. 追加したい本を書く欄
を並べた Markdown を出力する。答えを書き込んだファイルを Claude に渡せば、books.yaml に反映できる。

使い方（satellite-learning-roadmap フォルダで）:
    py tools/make_book_survey.py 出力先.md
"""
import sys
from datetime import date
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"

LEVEL_NAMES = {"intro": "入門", "basic": "基礎", "advanced": "専門"}
LEVEL_ORDER = ["intro", "basic", "advanced"]
EMPTY_BOOK_SLOTS = 2   # 「追加したい本」の空欄の数


def load_yaml(name):
    """data フォルダの YAML ファイルを読む。読めなければ原因を出して止める。"""
    path = DATA_DIR / name
    try:
        with open(path, encoding="utf-8") as f:
            return yaml.safe_load(f) or []
    except (OSError, yaml.YAMLError) as error:
        sys.exit(f"エラー：{path} を読めませんでした（{error}）")


def field_label(track):
    """見出しに使う分野名（共通基礎だけは表示名をページに合わせる）。"""
    name = "共通（全体像）" if track.get("common") else track["name"]
    return f"{name}（{track['id']}）"


def book_line(book):
    """本1冊分の書誌情報を1行にする。"""
    tags = [LEVEL_NAMES.get(book.get("level"), "?")]
    if book.get("lang") == "en":
        tags.append("英語")
    if book.get("free"):
        tags.append("無料")
    pub = "／".join(str(x) for x in [book.get("author"), book.get("publisher"), book.get("year")] if x)
    return f"**{book['title']}**（{pub}）［{'・'.join(tags)}］"


def field_section(track, books, skills):
    """1分野分の質問を作る。"""
    lines = [f"## {field_label(track)}", ""]
    field_books = [b for b in books if b.get("field") == track["id"]]
    field_books.sort(key=lambda b: LEVEL_ORDER.index(b["level"]) if b.get("level") in LEVEL_ORDER else 9)

    lines += ["### Q1. いま載っている本は必要ですか", ""]
    if field_books:
        for b in field_books:
            lines += [
                f"- {book_line(b)}　`{b['id']}`",
                "  - 必要度（◎ 必須 ／ ○ あるとよい ／ × いらない ／ ? 分からない）：",
                "  - コメント（読む章・順番・代わりの本など）：",
            ]
    else:
        lines.append("- （まだ1冊もありません）")
    lines.append("")

    wanted = [s for s in skills if s.get("field") == track["id"] and not s.get("books")]
    if wanted:
        lines += ["### Q2. 次のスキルを学べる本はありますか（本がまだないスキル）", ""]
        for s in wanted:
            lines.append(f"- {s['title']}　`{s['id']}`：")
        lines.append("")

    lines += ["### Q3. ほかに追加したい本", ""]
    for _ in range(EMPTY_BOOK_SLOTS):
        lines += [
            "- 書名：",
            "  - 著者・出版社・発行年：",
            "  - レベル（入門 ／ 基礎 ／ 専門）：",
            "  - 身につくスキル・おすすめの理由：",
        ]
    lines += ["", "---", ""]
    return lines


def main():
    if len(sys.argv) != 2:
        sys.exit("使い方：py tools/make_book_survey.py 出力先.md")
    out_path = Path(sys.argv[1])

    tracks = load_yaml("tracks.yaml")
    skills = load_yaml("nodes.yaml")
    books = load_yaml("books.yaml")

    lines = [
        "# 人工衛星開発への道：分野ごとの本の質問票",
        "",
        f"作成日：{date.today().isoformat()}（ロードマップのデータから自動で作成。本 {len(books)} 冊・スキル {len(skills)} 個）",
        "",
        "ロードマップに載せる本を決めるための質問票です。分かる分野だけ答えてください。",
        "",
        "- **Q1**：載っている本ごとに、必要度を ◎ ○ × ? のどれかで書きます。コメントは任意です",
        "- **Q2**：本がまだないスキルについて、学べる本があれば書名を書きます",
        "- **Q3**：ほかに入れたい本があれば書きます",
        "",
        "書き終わったファイルを Claude に渡すと、`data/books.yaml` に反映できます。",
        "本名・連絡先は書かないでください（ロードマップのページは公開する予定です）。",
        "",
        "回答者（ニックネーム）：",
        "",
        "---",
        "",
    ]
    for track in tracks:
        lines += field_section(track, books, skills)

    out_path.write_text("\n".join(lines), encoding="utf-8")
    print(f"作成しました：{out_path}")


if __name__ == "__main__":
    main()

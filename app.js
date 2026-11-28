// =============================================================
// Satellite Development Roadmap の画面を動かすプログラム
//
// 主役は「本のロードマップ」。スキルは本の補足として控えめに出す。
//
// 処理の流れ
//   1. data/ の YAML ファイル（分野・スキル・本・工程）を読み込み、矛盾がないか確かめる
//   2. 分野カード（上部）と最終目標の工程図（下部）を描く
//   3. 本を「行＝分野、列＝入門・基礎・専門」の表に並べる
//      - 本のカードの下に、その本で身につくスキルを小さく出す
//      - 各分野の行の下に、まだ本が決まっていないスキルを「本を募集中」として小さく出す
//   4. カードの位置を測り、「次に読む本」の矢印を SVG で描く（画面の大きさが変わったら描き直す）
//   5. 本やスキルを選ぶと詳細パネルを出す。本を選んだときは、つながる矢印を光らせる
//   6. チェック（読んだ・身についた）はブラウザの localStorage に保存する（登録不要）
// =============================================================

// ---------- 定数 ----------
// データファイルの場所。相対パスなので、GitHub Pages のサブパス（/リポジトリ名/）でもそのまま動く
const DATA_PATHS = {
  tracks: "./data/tracks.yaml",
  skills: "./data/nodes.yaml",
  books: "./data/books.yaml",
  process: "./data/process.yaml",
};

// チェック状態を保存するときの名前（ブラウザの localStorage のキー）
const STORAGE_KEYS = {
  skills: "satellite-roadmap:done-skills:v1",
  books: "satellite-roadmap:done-books:v1",
};

const KIND_SKILL = "skill";
const KIND_BOOK = "book";
const COMMON_FIELD_ID = "common";

// 表の列（本のレベル）
const BOOK_COLUMNS = [
  { id: "intro", name: "入門", desc: "最初に読む。全体像と面白さをつかむ" },
  { id: "basic", name: "基礎", desc: "分野の教科書。設計の考え方を学ぶ" },
  { id: "advanced", name: "専門", desc: "必要な章を引いて使う専門書・英語の定番" },
];
const STAGE_NAMES = { basic: "基礎", applied: "応用", practice: "実践" };
const LEVEL_NAMES = { intro: "入門", basic: "基礎", advanced: "専門" };

// 本のカードに名前を出すスキルの最大数（それ以上は「ほか N」とまとめる）
const MAX_SKILLS_ON_CARD = 3;

// 矢印の形の数値（px）
const EDGE_MIN_GAP = 8;        // カードどうしがこれ以上離れていれば「横向きの矢印」にする
const EDGE_SIDE_BULGE = 22;    // 同じ列のカードをつなぐとき、左の余白にふくらませる量
const EDGE_HEAD_GAP = 3;       // 矢印の先をカードから少し離す量

// 本の推薦フォーム（GitHub の Issue フォーム）
// GitHub にリポジトリを作ったら、そのアドレスを入れる（例："https://github.com/ユーザー名/satellite-learning-roadmap"）。
// 空のあいだは「推薦する」リンクを押せない表示にする
const GITHUB_REPO_URL = "https://github.com/ysntera/satellite-learning-roadmap";
const RECOMMEND_TEMPLATE = "book-recommendation.yml";   // .github/ISSUE_TEMPLATE/ の中のファイル名

// これ以下の幅ではスマホ用の表示（style.css の @media と同じ値にする）
const NARROW_SCREEN = "(max-width: 760px)";

// ---------- 画面全体の状態 ----------
const state = {
  tracks: [],
  skills: [],
  books: [],
  process: [],
  field_filter: null,      // 絞り込み中の分野の id（null ならすべて）
  selected: null,          // 選んでいるもの { kind, id }
  done: { skills: new Set(), books: new Set() },
};

// id から素早く引くための表と、逆向きのつながり
const index = {
  track: new Map(),
  skill: new Map(),
  book: new Map(),
  skill_next: new Map(),   // スキル id → そのスキルを前提にしているスキルの id の配列
  book_prev: new Map(),    // 本 id → その本の前に読むとよい本の id の配列
  book_used_by: new Map(), // 本 id → その本で身につくスキルの id の配列
};

// 表示中の本のカード（id → 要素）と矢印の一覧
let card_elements = new Map();
let edge_list = [];
let redraw_scheduled = false;

// =============================================================
// 小さな道具
// =============================================================
function escape_html(text) {
  return String(text ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function is_http_url(text) {
  return typeof text === "string" && /^https?:\/\/\S+$/.test(text);
}

function track_color(field_id) {
  return index.track.get(field_id)?.color || "#64748B";
}

function show_error(message) {
  const box = document.getElementById("error-box");
  box.hidden = false;
  box.textContent += (box.textContent ? "\n" : "") + message;
}

function is_narrow_screen() {
  return window.matchMedia(NARROW_SCREEN).matches;
}

function done_set(kind) {
  return kind === KIND_SKILL ? state.done.skills : state.done.books;
}

function push_to(map, key, value) {
  if (!map.has(key)) map.set(key, []);
  map.get(key).push(value);
}

// =============================================================
// 1. データの読み込みと検査
// =============================================================
async function load_yaml(path) {
  const response = await fetch(path, { cache: "no-cache" });
  if (!response.ok) {
    throw new Error(`${path} を読み込めませんでした（HTTP ${response.status}）。`
      + "HTML ファイルをダブルクリックで開いた場合は、README の手順で簡単なサーバーを立ててから開いてください。");
  }
  const data = jsyaml.load(await response.text());
  if (!Array.isArray(data)) throw new Error(`${path} の中身がリスト（- で始まる項目の並び）になっていません。`);
  return data;
}

async function load_all_data() {
  const [tracks, skills, books, process] = await Promise.all([
    load_yaml(DATA_PATHS.tracks),
    load_yaml(DATA_PATHS.skills),
    load_yaml(DATA_PATHS.books),
    load_yaml(DATA_PATHS.process),
  ]);
  state.tracks = tracks;
  state.skills = skills;
  state.books = books;
  state.process = process;
}

// 存在しない id を指しているところは取り除き、警告を出す（ページは表示を続ける）
function build_index_and_validate() {
  const warnings = [];
  state.tracks.forEach((t) => index.track.set(t.id, t));
  state.skills.forEach((s) => index.skill.set(s.id, s));
  state.books.forEach((b) => index.book.set(b.id, b));

  state.skills.forEach((s) => {
    if (!index.track.has(s.field)) warnings.push(`スキル「${s.id}」の field「${s.field}」がありません`);
    if (!STAGE_NAMES[s.stage]) warnings.push(`スキル「${s.id}」の stage「${s.stage}」が不正です`);
    s.prerequisites = (s.prerequisites || []).filter((p) => {
      if (index.skill.has(p)) return true;
      warnings.push(`スキル「${s.id}」の前提「${p}」がありません`);
      return false;
    });
    s.books = (s.books || []).filter((b) => {
      if (index.book.has(b)) return true;
      warnings.push(`スキル「${s.id}」の本「${b}」が books.yaml にありません`);
      return false;
    });
  });
  state.books.forEach((b) => {
    if (!index.track.has(b.field)) warnings.push(`本「${b.id}」の field「${b.field}」がありません`);
    if (!LEVEL_NAMES[b.level]) warnings.push(`本「${b.id}」の level「${b.level}」が不正です`);
    b.next = (b.next || []).filter((n) => {
      if (index.book.has(n)) return true;
      warnings.push(`本「${b.id}」の次に読む本「${n}」がありません`);
      return false;
    });
  });

  // 逆向きのつながりを作る
  state.skills.forEach((s) => {
    s.prerequisites.forEach((p) => push_to(index.skill_next, p, s.id));
    s.books.forEach((b) => push_to(index.book_used_by, b, s.id));
  });
  state.books.forEach((b) => b.next.forEach((n) => push_to(index.book_prev, n, b.id)));

  if (warnings.length) show_error("データに問題があります（README の「データの検査」を参照）：\n・" + warnings.join("\n・"));
}

// =============================================================
// チェック状態の保存（localStorage）
// =============================================================
function storage_key(kind) {
  return kind === KIND_SKILL ? STORAGE_KEYS.skills : STORAGE_KEYS.books;
}

function load_done() {
  for (const kind of [KIND_SKILL, KIND_BOOK]) {
    try {
      const saved = JSON.parse(localStorage.getItem(storage_key(kind)) || "[]");
      const valid_map = kind === KIND_SKILL ? index.skill : index.book;
      saved.filter((id) => valid_map.has(id)).forEach((id) => done_set(kind).add(id));
    } catch (error) {
      console.warn("チェック状態を読み込めませんでした。最初からにします。", error);
    }
  }
}

function save_done(kind) {
  try {
    localStorage.setItem(storage_key(kind), JSON.stringify([...done_set(kind)]));
  } catch (error) {
    // プライベートブラウズなどで保存できない場合。チェックはこの画面を開いている間だけ有効
    console.warn("チェック状態を保存できませんでした。", error);
  }
}

function toggle_done(kind, id) {
  const set = done_set(kind);
  if (set.has(id)) set.delete(id); else set.add(id);
  save_done(kind);
  refresh_done_ui();
}

function reset_all_done() {
  state.done.skills.clear();
  state.done.books.clear();
  save_done(KIND_SKILL);
  save_done(KIND_BOOK);
  refresh_done_ui();
}

// チェックが変わったときに、カード・進捗バー・詳細パネルを更新する（表は作り直さない）
function refresh_done_ui() {
  card_elements.forEach((el, id) => {
    const is_done = state.done.books.has(id);
    el.classList.toggle("done", is_done);
    const check = el.querySelector(".card-check");
    check.setAttribute("aria-pressed", String(is_done));
    check.querySelector(".check-icon").textContent = is_done ? "✓" : "";
  });
  // 本のカードの中のスキル名・募集中の行のスキル名にも、身についた印を付ける
  document.querySelectorAll("#board [data-skill-id]").forEach((el) => {
    el.classList.toggle("done", state.done.skills.has(el.dataset.skillId));
  });
  render_progress();
  render_detail();
}

// =============================================================
// 進捗の表示（全体・分野ごと）
// =============================================================
function count_progress(kind, field_id) {
  const items = kind === KIND_SKILL ? state.skills : state.books;
  const target = field_id ? items.filter((it) => it.field === field_id) : items;
  const done = target.filter((it) => done_set(kind).has(it.id)).length;
  return { done, total: target.length };
}

function set_bar(bar_el, text_el, { done, total }, empty_text = "0 / 0") {
  const ratio = total ? done / total : 0;
  bar_el.style.width = `${Math.round(ratio * 100)}%`;
  if (text_el) text_el.textContent = total ? `${done} / ${total}` : empty_text;
}

function render_progress() {
  set_bar(document.getElementById("overall-book-bar"), document.getElementById("overall-book-text"),
    count_progress(KIND_BOOK));
  set_bar(document.getElementById("overall-skill-bar"), document.getElementById("overall-skill-text"),
    count_progress(KIND_SKILL));

  // 分野カードと表の行の見出し：読んだ本の数を出す
  document.querySelectorAll(".field-card, .lane-head").forEach((el) => {
    const p = count_progress(KIND_BOOK, el.dataset.field);
    set_bar(el.querySelector(".bar-fill"), el.querySelector(".progress-count"), p, "本：募集中");
  });
}

// =============================================================
// 2. 分野カードと工程図
// =============================================================
function render_field_cards() {
  const container = document.getElementById("field-cards");
  container.innerHTML = state.tracks.map((t) => `
    <button type="button" class="field-card" data-field="${escape_html(t.id)}" style="--c:${escape_html(t.color)}"
      aria-pressed="false" title="${escape_html(t.name_en || t.name)}：この分野だけを表示">
      <span class="field-card-name"><span class="swatch" aria-hidden="true"></span>${escape_html(t.common ? "共通（全体像）" : t.name)}
        ${t.cross ? '<span class="field-card-note">全分野をつなぐ</span>' : ""}
        ${t.common ? '<span class="field-card-note">最初に読む</span>' : ""}
      </span>
      <span class="field-card-desc">${escape_html(t.description || "")}</span>
      <span class="field-card-progress">
        <span class="bar"><span class="bar-fill" style="display:block"></span></span>
        <span class="progress-count">0 / 0</span>
      </span>
    </button>`).join("");
  container.querySelectorAll(".field-card").forEach((card) => {
    card.addEventListener("click", () => set_field_filter(card.dataset.field));
  });
}

function render_process() {
  const container = document.getElementById("process");
  const steps = state.process.map((step, i) => `
    <div class="process-step">
      <span class="process-num">${i + 1}</span>
      <span class="process-name">${escape_html(step.name)}</span>
      <span class="process-desc">${escape_html(step.description)}</span>
      <span class="process-fields">
        ${(step.fields || []).filter((f) => index.track.has(f)).map((f) => field_chip_button(f)).join("")}
      </span>
    </div>`).join("");
  container.innerHTML = `
    <div class="process-steps">${steps}</div>
    <div class="process-se">
      ${field_chip_button("system")}
      <span><strong>システムズエンジニアリング</strong>は、ミッション定義から運用まで、すべての工程で
      要求・インターフェース（分野どうしの取り決め）・検証をつなぎ、8つの分野を1機の衛星にまとめます。</span>
    </div>`;
  container.querySelectorAll("[data-goto-field]").forEach((btn) => {
    btn.addEventListener("click", () => {
      set_field_filter(btn.dataset.gotoField, true);
      document.querySelector(".roadmap-section").scrollIntoView({ behavior: "smooth" });
    });
  });
}

// =============================================================
// 本の推薦リンク
//   押すと GitHub の Issue フォームが開き、分野（とスキル）が最初から入った状態になる。
//   フォームの項目 id（field / skill）は .github/ISSUE_TEMPLATE/book-recommendation.yml と合わせる
// =============================================================
function recommend_url(field_id, skill) {
  if (!GITHUB_REPO_URL) return null;
  const track = index.track.get(field_id);
  const field_label = track ? `${track.name}（${track.id}）` : "";
  const params = new URLSearchParams({
    template: RECOMMEND_TEMPLATE,
    title: `[本の推薦] ${track ? track.name : ""}${skill ? "：" + skill.title : ""}：`,
    field: field_label,
  });
  if (skill) params.set("skill", `${skill.title}（${skill.id}）`);
  return `${GITHUB_REPO_URL.replace(/\/$/, "")}/issues/new?${params.toString()}`;
}

// リンクの href は GitHub のフォームのまま残す（新しいタブで開く操作や、JavaScript が動かないときの予備）。
// ふつうにクリックしたときは setup_recommend_dialog() の処理で、ページ内の大きなフォームを開く
function recommend_link_html(field_id, skill = null, label = "＋ 本を推薦する") {
  const url = recommend_url(field_id, skill);
  if (!url) {
    return `<span class="recommend-link disabled" title="GitHub に公開したあとで使えるようになります">${escape_html(label)}（公開後に使えます）</span>`;
  }
  return `<a class="recommend-link" href="${escape_html(url)}" target="_blank" rel="noopener"
    data-rec-field="${escape_html(field_id)}" data-rec-skill="${escape_html(skill ? skill.id : "")}">${escape_html(label)}</a>`;
}

// =============================================================
// 本の推薦フォーム（ページ内の大きな画面）
//   1枚目で入力 → 2枚目で確認し、「GitHub を開く」で、入力した内容を URL の「?項目id=値」に入れた
//   GitHub の Issue フォームを開く。
//   GitHub 側で「Create」を押すまでは何も送られない（このページはどこにもデータを保存しない）
// =============================================================

// レベルの選択肢。value がそのまま GitHub の Issue フォームの「レベル」の欄に文字で入る
const REC_LEVELS = [
  { value: "入門（最初に読む。全体像と面白さをつかむ）", name: "入門", desc: "最初に読む。全体像と面白さをつかむ" },
  { value: "基礎（分野の教科書。設計の考え方を学ぶ）", name: "基礎", desc: "分野の教科書。設計の考え方を学ぶ" },
  { value: "専門（必要な章を引いて使う専門書・英語の定番）", name: "専門", desc: "必要な章を引いて使う専門書・英語の定番" },
  { value: "分からない", name: "分からない", desc: "迷ったらこれ。管理者が決めます" },
];
// 「そのほか」のチェック。チェックしたものを「、」でつないで、Issue フォームの「そのほか」の欄に入れる
const REC_EXTRAS = ["英語の本・資料", "無料で読める（PDF など）", "自分で読んだことがある"];
// GitHub が受け付ける URL の長さには上限がある（約 8000 文字）。日本語は 1 文字が約 9 文字に増えるので余裕をみる
const REC_MAX_URL_LENGTH = 7500;

const rec = { dialog: null, form: null };

function setup_recommend_dialog() {
  rec.dialog = document.getElementById("recommend-dialog");
  rec.form = document.getElementById("recommend-form");
  if (!rec.dialog || !GITHUB_REPO_URL) return;

  // 分野の選択肢
  const field_select = document.getElementById("rec-field");
  field_select.innerHTML = state.tracks
    .map((t) => `<option value="${escape_html(t.id)}">${escape_html(t.name)}（${escape_html(t.id)}）</option>`).join("");
  field_select.addEventListener("change", () => render_rec_skills([]));

  // レベル（大きめのボタン型のラジオボタン）
  document.getElementById("rec-level").innerHTML = REC_LEVELS.map((lv) => `
    <label class="rec-level"><input type="radio" name="level" value="${escape_html(lv.value)}">
      <span class="rec-level-name">${escape_html(lv.name)}</span><span class="rec-level-desc">${escape_html(lv.desc)}</span></label>`).join("");

  // そのほか
  document.getElementById("rec-extra").innerHTML = REC_EXTRAS.map((label) => `
    <label class="rec-check"><input type="checkbox" name="extra" value="${escape_html(label)}"> ${escape_html(label)}</label>`).join("");

  // 「前後に読むとよい本」の入力候補（載っている本の書名）
  document.getElementById("rec-book-list").innerHTML = state.books
    .map((b) => `<option value="「${escape_html(b.title)}」のあとに読む"></option>`).join("");

  // 推薦リンクのクリック（表は何度も描き直すので、ページ全体で1回だけ受け取る）
  document.addEventListener("click", (event) => {
    const link = event.target.closest("a.recommend-link[data-rec-field]");
    if (!link) return;
    // Ctrl / ⌘ / 中ボタンでのクリックは、ブラウザどおり GitHub のフォームを新しいタブで開く
    if (event.ctrlKey || event.metaKey || event.shiftKey || event.button !== 0) return;
    event.preventDefault();
    open_recommend_dialog(link.dataset.recField, link.dataset.recSkill || null);
  });

  rec.dialog.querySelectorAll("[data-rec-close]").forEach((btn) =>
    btn.addEventListener("click", () => rec.dialog.close()));
  // 枠の外（暗いところ）を押しても閉じる
  rec.dialog.addEventListener("click", (event) => { if (event.target === rec.dialog) rec.dialog.close(); });
  rec.form.addEventListener("submit", (event) => { event.preventDefault(); submit_recommend(); });
  rec.form.addEventListener("input", () => hide_rec_error());
  document.getElementById("rec-back").addEventListener("click", () => show_rec_page("form"));
  document.getElementById("rec-new").addEventListener("click", reset_recommend_form);
}

// 選んだ分野のスキルを、チェックボックスで並べる
function render_rec_skills(checked_ids) {
  const field_id = document.getElementById("rec-field").value;
  const skills = state.skills.filter((s) => s.field === field_id);
  document.getElementById("rec-skills").innerHTML = skills.length
    ? skills.map((s) => `
      <label class="rec-check"><input type="checkbox" name="skill" value="${escape_html(s.id)}"
        ${checked_ids.includes(s.id) ? "checked" : ""}> ${escape_html(s.title)}
        ${s.books.length ? "" : '<span class="rec-wanted">募集中</span>'}</label>`).join("")
    : '<p class="muted">この分野にはまだスキルがありません。下の欄に書いてください。</p>';
}

function open_recommend_dialog(field_id, skill_id) {
  const field_select = document.getElementById("rec-field");
  const field_changed = field_select.value !== field_id;
  if (index.track.has(field_id)) field_select.value = field_id;
  // 同じ分野をもう一度開いたときは、書きかけの内容を残す。スキルから開いたときはそのスキルにチェックを付ける
  const checked = field_changed ? [] : selected_rec_skill_ids();
  if (skill_id && !checked.includes(skill_id)) checked.push(skill_id);
  render_rec_skills(checked);
  update_rec_direct_link(field_id, skill_id);
  hide_rec_error();
  rec.dialog.showModal();
  show_rec_page("form");
}

function selected_rec_skill_ids() {
  return [...rec.form.querySelectorAll('input[name="skill"]:checked')].map((el) => el.value);
}

function update_rec_direct_link(field_id, skill_id) {
  const url = recommend_url(field_id, skill_id ? index.skill.get(skill_id) : null);
  document.getElementById("rec-direct-link").href = url || "#";
}

// 入力内容を、GitHub の Issue フォームの URL にする
function build_recommend_issue_url() {
  const value = (id) => document.getElementById(id).value.trim();
  const track = index.track.get(value("rec-field"));
  const skills = selected_rec_skill_ids().map((id) => index.skill.get(id)).filter(Boolean);
  const skill_texts = skills.map((s) => `${s.title}（${s.id}）`);
  if (value("rec-skill-other")) skill_texts.push(value("rec-skill-other"));
  const level = rec.form.querySelector('input[name="level"]:checked')?.value || "";
  const extras = [...rec.form.querySelectorAll('input[name="extra"]:checked')].map((el) => el.value);

  const params = new URLSearchParams({
    template: RECOMMEND_TEMPLATE,
    title: `[本の推薦] ${track ? track.name : ""}：${value("rec-book-title")}`,
    field: track ? `${track.name}（${track.id}）` : "",
    book_title: value("rec-book-title"),
    author: value("rec-author"),
    url: value("rec-url"),
    level: level,
    skill: skill_texts.join("、"),
    order: value("rec-order"),
    reason: value("rec-reason"),
  });
  if (extras.length) params.set("extra", extras.join("、"));
  // 空の項目は URL に入れない（短くするため）
  [...params.keys()].forEach((key) => { if (!params.get(key)) params.delete(key); });
  return `${GITHUB_REPO_URL.replace(/\/$/, "")}/issues/new?${params.toString()}`;
}

// 必須の項目が埋まっているか確かめる。足りなければ、何が足りないかの文を返す
function check_recommend_form() {
  const missing = [];
  if (!document.getElementById("rec-book-title").value.trim()) missing.push("書名");
  if (!rec.form.querySelector('input[name="level"]:checked')) missing.push("レベル");
  if (!document.getElementById("rec-reason").value.trim()) missing.push("おすすめの理由");
  const url = document.getElementById("rec-url").value.trim();
  if (url && !is_http_url(url)) return "URL は https:// から始まる形で書いてください（分からなければ空欄で大丈夫です）。";
  return missing.length ? `${missing.join("・")}を入力してください。` : "";
}

function submit_recommend() {
  const problem = check_recommend_form();
  if (problem) { show_rec_error(problem); return; }
  const url = build_recommend_issue_url();
  if (url.length > REC_MAX_URL_LENGTH) {
    show_rec_error("文章が長すぎて GitHub に渡せません。おすすめの理由を短くするか、GitHub のページで書き足してください。");
    return;
  }
  // 2枚目（確認と GitHub へ進む画面）に切り替える。
  // GitHub へは、ボタン（ふつうのリンク）を押して移るので、ブラウザのポップアップ防止に止められない
  document.getElementById("rec-go-github").href = url;
  document.getElementById("rec-summary").innerHTML = recommend_summary_html();
  show_rec_page("confirm");
}

// 確認画面に出す一覧（入力のない項目は出さない）
function recommend_summary_html() {
  const value = (id) => document.getElementById(id).value.trim();
  const track = index.track.get(value("rec-field"));
  const skills = selected_rec_skill_ids().map((id) => index.skill.get(id)?.title).filter(Boolean);
  if (value("rec-skill-other")) skills.push(value("rec-skill-other"));
  const level = rec.form.querySelector('input[name="level"]:checked')?.value || "";
  const extras = [...rec.form.querySelectorAll('input[name="extra"]:checked')].map((el) => el.value);
  const rows = [
    ["分野", track ? track.name : ""],
    ["書名", value("rec-book-title")],
    ["著者・出版社・発行年", value("rec-author")],
    ["URL", value("rec-url")],
    ["レベル", level],
    ["身につくスキル", skills.join("、")],
    ["前後に読むとよい本", value("rec-order")],
    ["おすすめの理由", value("rec-reason")],
    ["そのほか", extras.join("、")],
  ];
  return rows.filter(([, v]) => v)
    .map(([k, v]) => `<div><dt>${escape_html(k)}</dt><dd>${escape_html(v)}</dd></div>`).join("");
}

// "form"（1枚目：入力）と "confirm"（2枚目：確認）を切り替える
function show_rec_page(page) {
  rec.form.hidden = page !== "form";
  document.getElementById("rec-confirm").hidden = page !== "confirm";
  const focus_id = page === "confirm" ? "rec-go-github" : "rec-book-title";
  document.getElementById(focus_id).focus();
}

// 送り終えたら、次の推薦のために中身を空にして入力画面に戻す
function reset_recommend_form() {
  const field_id = document.getElementById("rec-field").value;
  rec.form.reset();
  document.getElementById("rec-field").value = field_id;   // 分野は続けて同じものを使うことが多いので残す
  render_rec_skills([]);
  show_rec_page("form");
}

function show_rec_error(message) {
  const el = document.getElementById("rec-error");
  el.textContent = message;
  el.hidden = false;
}
function hide_rec_error() { document.getElementById("rec-error").hidden = true; }

function field_chip_button(field_id) {
  const t = index.track.get(field_id);
  if (!t) return "";
  return `<button type="button" class="link-chip" style="--c:${escape_html(t.color)}"
    data-goto-field="${escape_html(t.id)}">${escape_html(t.name)}</button>`;
}

// =============================================================
// 3. 本のロードマップの表（行＝分野、列＝入門・基礎・専門）
// =============================================================
function visible_lanes() {
  if (!state.field_filter) return state.tracks;
  return state.tracks.filter((t) => t.id === COMMON_FIELD_ID || t.id === state.field_filter);
}

function render_board() {
  const board = document.getElementById("board");
  card_elements = new Map();
  const parts = [];

  // 列の見出し
  parts.push('<div class="col-head col-corner" aria-hidden="true"></div>');
  BOOK_COLUMNS.forEach((c) => parts.push(`
    <div class="col-head"><div class="col-head-name">${escape_html(c.name)}</div>
      <div class="col-head-desc">${escape_html(c.desc)}</div></div>`));

  // 各分野の行
  visible_lanes().forEach((lane) => {
    const lane_books = state.books.filter((b) => b.field === lane.id);
    const wanted_skills = state.skills.filter((s) => s.field === lane.id && s.books.length === 0);
    parts.push(`
      <div class="lane-head ${lane.cross ? "cross" : ""}" data-field="${escape_html(lane.id)}" style="--c:${escape_html(lane.color)}">
        <span class="lane-head-name"><span class="swatch" aria-hidden="true"></span>${escape_html(lane.common ? "共通（全体像）" : lane.name)}</span>
        <span class="lane-head-progress"><span class="progress-count">0 / 0</span>
          <span class="bar"><span class="bar-fill" style="display:block"></span></span></span>
      </div>`);
    BOOK_COLUMNS.forEach((c) => {
      const cell_books = lane_books.filter((b) => b.level === c.id);
      parts.push(`<div class="cell"><span class="cell-stage-label">${escape_html(c.name)}</span>
        ${cell_books.map(book_card_html).join("") || '<div class="cell-empty">—</div>'}</div>`);
    });
    // 行の下：本がまだないスキルを小さくまとめ、最後にこの分野の本を推薦するリンクを置く
    const wanted_html = wanted_skills.length
      ? `<span class="wanted-label">本を募集中のスキル：</span>
         ${wanted_skills.map((s) => skill_text_button(s)).join('<span class="sep">・</span>')}`
      : "";
    parts.push(`<div class="wanted-row"><span class="wanted-skills">${wanted_html}</span>
      ${recommend_link_html(lane.id, null, `＋ ${lane.common ? "共通（全体像）" : lane.name}の本を推薦する`)}</div>`);
  });

  board.innerHTML = parts.join("")
    + `<svg class="edges" aria-hidden="true"><defs>
         <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
           <path d="M0,0 L10,5 L0,10 z" class="edge-head" style="fill:context-stroke"></path>
         </marker></defs><g class="edge-layer"></g></svg>`;

  board.querySelectorAll(".card").forEach((el) => {
    const id = el.dataset.id;
    card_elements.set(id, el);
    el.querySelector(".card-main").addEventListener("click", () => select_item(KIND_BOOK, id));
    el.querySelector(".card-check").addEventListener("click", () => toggle_done(KIND_BOOK, id));
  });
  board.querySelectorAll("button[data-skill-id]").forEach((btn) => {
    btn.addEventListener("click", () => select_item(KIND_SKILL, btn.dataset.skillId));
  });

  edge_list = build_edges();
  render_legend();
  render_progress();
  schedule_redraw_edges();
}

// スキル名を小さな文字のボタンにする（募集中の行で使う）
function skill_text_button(s) {
  const done = state.done.skills.has(s.id) ? "done" : "";
  return `<button type="button" class="skill-text ${done}" data-skill-id="${escape_html(s.id)}"
    title="${escape_html(STAGE_NAMES[s.stage] || "")}：詳細を見る">${escape_html(s.title)}</button>`;
}

function book_card_html(b) {
  const color = track_color(b.field);
  const is_done = state.done.books.has(b.id);
  let tags = "";
  if (b.candidate) tags += '<span class="tag candidate">候補</span>';
  if (b.lang === "en") tags += '<span class="tag lang">英語</span>';
  if (b.free) tags += '<span class="tag free">無料</span>';

  // この本で身につくスキル（控えめに、名前だけを小さく出す）
  const skill_ids = index.book_used_by.get(b.id) || [];
  const shown = skill_ids.slice(0, MAX_SKILLS_ON_CARD).map((id) => {
    const done = state.done.skills.has(id) ? "done" : "";
    return `<span class="card-skill ${done}" data-skill-id="${escape_html(id)}">${escape_html(index.skill.get(id).title)}</span>`;
  });
  const rest = skill_ids.length - shown.length;
  const skills_html = skill_ids.length
    ? `<span class="card-skills"><span class="card-skills-label">身につく</span>${shown.join("・")}${rest > 0 ? ` ほか${rest}` : ""}</span>`
    : "";

  return `
    <div class="card ${is_done ? "done" : ""}" data-id="${escape_html(b.id)}" style="--c:${escape_html(color)}">
      <button type="button" class="card-main" aria-label="${escape_html(b.title)} の詳細を見る">
        <span class="card-title">${escape_html(b.title)}</span>
        <span class="card-sub">${escape_html([b.author, b.year].filter(Boolean).join("／"))}</span>
        ${tags ? `<span class="card-tags">${tags}</span>` : ""}
        ${skills_html}
      </button>
      <button type="button" class="card-check" aria-pressed="${is_done}" title="読んだにする／外す"
        aria-label="${escape_html(b.title)} を読んだにする">
        <span class="check-icon">${is_done ? "✓" : ""}</span>
      </button>
    </div>`;
}

function render_legend() {
  document.getElementById("roadmap-legend").innerHTML = `
    <span class="legend-item"><span class="legend-line"></span>次に読む本</span>
    <span class="legend-item"><span class="legend-line cross"></span>ほかの分野の本へ</span>
    <span class="legend-item">本の下の小さな字は、その本で身につくスキル</span>`;
  document.getElementById("show-all-btn").hidden = !state.field_filter;
}

// =============================================================
// 4. 矢印（SVG）
// =============================================================
function build_edges() {
  const pairs = [];
  state.books.forEach((b) => b.next.forEach((n) => pairs.push([b.id, n])));
  return pairs
    .filter(([from, to]) => card_elements.has(from) && card_elements.has(to))
    .map(([from, to]) => {
      const from_field = index.book.get(from).field;
      const to_field = index.book.get(to).field;
      const cross = from_field !== to_field;
      const from_common = cross && from_field === COMMON_FIELD_ID;
      return { from, to, cross, from_common, color: track_color(to_field) };
    });
}

function schedule_redraw_edges() {
  if (redraw_scheduled) return;
  redraw_scheduled = true;
  requestAnimationFrame(() => {
    redraw_scheduled = false;
    draw_edges();
  });
}

// カードの位置（表の左上からの距離）を測る
function card_box(el, board_rect) {
  const r = el.getBoundingClientRect();
  const left = r.left - board_rect.left;
  const top = r.top - board_rect.top;
  return { left, top, right: left + r.width, bottom: top + r.height, cx: left + r.width / 2, cy: top + r.height / 2 };
}

// 2つのカードをつなぐ曲線（SVG の path）を作る
function edge_path(s, t) {
  // ① 行き先が右にある：右端から左端へ横向きに
  if (t.left - s.right > EDGE_MIN_GAP) {
    const x1 = s.right, y1 = s.cy, x2 = t.left - EDGE_HEAD_GAP, y2 = t.cy;
    const dx = Math.max(24, (x2 - x1) * 0.5);
    return `M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}`;
  }
  // ② 行き先が左にある：左端から右端へ
  if (s.left - t.right > EDGE_MIN_GAP) {
    const x1 = s.left, y1 = s.cy, x2 = t.right + EDGE_HEAD_GAP, y2 = t.cy;
    const dx = Math.max(24, (x1 - x2) * 0.5);
    return `M${x1},${y1} C${x1 - dx},${y1} ${x2 + dx},${y2} ${x2},${y2}`;
  }
  // ③ 同じ列（縦に並んでいる）：左の余白にふくらませてつなぐ
  const x1 = s.left, y1 = s.cy, x2 = t.left - EDGE_HEAD_GAP, y2 = t.cy;
  const bulge = EDGE_SIDE_BULGE + Math.min(10, Math.abs(y2 - y1) * 0.02);
  return `M${x1},${y1} C${x1 - bulge},${y1} ${x2 - bulge},${y2} ${x2},${y2}`;
}

function draw_edges() {
  const board = document.getElementById("board");
  if (!board) return;   // 表がまだない（またはページが置き換わった）ときは何もしない
  const layer = board.querySelector(".edge-layer");
  const svg = board.querySelector("svg.edges");
  if (!layer || !svg) return;
  svg.setAttribute("width", board.scrollWidth);
  svg.setAttribute("height", board.scrollHeight);
  const board_rect = board.getBoundingClientRect();

  layer.innerHTML = edge_list.map((e, i) => {
    const s = card_box(card_elements.get(e.from), board_rect);
    const t = card_box(card_elements.get(e.to), board_rect);
    const classes = ["edge", e.cross ? "cross" : "", e.from_common ? "from-common" : ""].join(" ");
    return `<path class="${classes}" data-i="${i}" d="${edge_path(s, t)}" marker-end="url(#arrow)"
      style="--hl:${escape_html(e.color)}"></path>`;
  }).join("");
  apply_highlight();
}

// 選んでいる本につながる矢印を光らせ、つながる本に印を付ける
function apply_highlight() {
  const selected_id = state.selected?.kind === KIND_BOOK ? state.selected.id : null;
  const related = new Set();
  document.querySelectorAll("#board .edge").forEach((path) => {
    const e = edge_list[Number(path.dataset.i)];
    const hit = selected_id && (e.from === selected_id || e.to === selected_id);
    path.classList.toggle("hl", Boolean(hit));
    path.classList.toggle("dim", Boolean(selected_id && !hit));
    if (hit) related.add(e.from === selected_id ? e.to : e.from);
  });
  card_elements.forEach((el, id) => {
    el.classList.toggle("selected", id === selected_id);
    el.classList.toggle("related", related.has(id));
  });
  // スキルを選んでいるときは、そのスキルの本に印を付ける
  if (state.selected?.kind === KIND_SKILL) {
    const skill = index.skill.get(state.selected.id);
    skill?.books.forEach((id) => card_elements.get(id)?.classList.add("related"));
  }
}

// =============================================================
// 5. 選択と詳細パネル
// =============================================================
function select_item(kind, id) {
  state.selected = { kind, id };
  // 絞り込みで見えていない本なら、絞り込みを外す
  if (kind === KIND_BOOK && !card_elements.has(id)) {
    state.field_filter = null;
    update_field_cards();
    render_board();
  }
  apply_highlight();
  render_detail();
  document.getElementById("detail").classList.add("open");
  const el = kind === KIND_BOOK ? card_elements.get(id) : null;
  if (el && !is_narrow_screen()) el.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "smooth" });
}

function close_detail() {
  document.getElementById("detail").classList.remove("open");
}

function render_detail() {
  const panel = document.getElementById("detail");
  const sel = state.selected;
  if (!sel) return;
  const item = sel.kind === KIND_SKILL ? index.skill.get(sel.id) : index.book.get(sel.id);
  if (!item) return;
  panel.innerHTML = '<button type="button" class="detail-close">閉じる ✕</button>'
    + (sel.kind === KIND_SKILL ? skill_detail_html(item) : book_detail_html(item));
  panel.scrollTop = 0;
  panel.querySelector(".detail-close").addEventListener("click", close_detail);
  panel.querySelector(".toggle-done")?.addEventListener("click", () => toggle_done(sel.kind, sel.id));
  panel.querySelectorAll("[data-select-kind]").forEach((btn) => {
    btn.addEventListener("click", () => select_item(btn.dataset.selectKind, btn.dataset.selectId));
  });
}

// スキルの一覧（控えめな文字のリンク）
function skill_list_html(ids) {
  if (!ids.length) return '<p class="muted">なし</p>';
  return `<ul class="skill-list">${ids.map((id) => {
    const s = index.skill.get(id);
    const done = state.done.skills.has(id) ? "done" : "";
    return `<li><button type="button" class="skill-text ${done}" data-select-kind="${KIND_SKILL}"
      data-select-id="${escape_html(id)}">${escape_html(s.title)}</button>
      <span class="skill-stage">${escape_html(index.track.get(s.field).common ? "共通基礎" : STAGE_NAMES[s.stage])}</span></li>`;
  }).join("")}</ul>`;
}

// 本の一覧（本のカード風のリンク）
function book_link_chips(ids) {
  if (!ids.length) return '<p class="muted">なし</p>';
  return `<div class="link-chips">${ids.map((id) => {
    const b = index.book.get(id);
    const done = state.done.books.has(id) ? "done" : "";
    return `<button type="button" class="link-chip ${done}" style="--c:${escape_html(track_color(b.field))}"
      data-select-kind="${KIND_BOOK}" data-select-id="${escape_html(id)}">${escape_html(b.title)}</button>`;
  }).join("")}</div>`;
}

function list_html(items, class_name = "") {
  if (!items?.length) return '<p class="muted">（未記入）</p>';
  return `<ul class="${class_name}">${items.map((x) => `<li>${escape_html(x)}</li>`).join("")}</ul>`;
}

function book_detail_html(b) {
  const track = index.track.get(b.field);
  const is_done = state.done.books.has(b.id);
  const tags = [
    b.candidate ? '<span class="tag candidate">候補（チームでは未確定）</span>' : "",
    b.lang === "en" ? '<span class="tag lang">英語</span>' : '<span class="tag lang">日本語</span>',
    b.free ? '<span class="tag free">無料で読める</span>' : "",
  ].join(" ");
  return `
    <div class="detail-chips">
      <span class="chip" style="--c:${escape_html(track.color)}">${escape_html(track.common ? "共通（全体像）" : track.name)}</span>
      <span class="chip stage">${escape_html(LEVEL_NAMES[b.level])}</span>
    </div>
    <h3>${escape_html(b.title)}</h3>
    <p>${tags}</p>
    <button type="button" class="toggle-done ${is_done ? "done" : ""}">${is_done ? "☑ 読んだ（押すと外す）" : "□ 読んだにする"}</button>
    <h4>書誌情報</h4>
    <p>${escape_html(b.author)}<br>${escape_html([b.publisher, b.year].filter(Boolean).join("／"))}</p>
    ${is_http_url(b.url) ? `<a class="open-link" href="${escape_html(b.url)}" target="_blank" rel="noopener">出版社・図書館のページを開く</a>` : ""}
    ${b.note ? `<h4>ひとこと</h4><p>${escape_html(b.note)}</p>` : ""}
    <h4>この前に読むとよい本</h4>${book_link_chips(index.book_prev.get(b.id) || [])}
    <h4>次に読む本</h4>${book_link_chips(b.next)}
    <h4>この本で身につくスキル</h4>${skill_list_html(index.book_used_by.get(b.id) || [])}`;
}

function skill_detail_html(s) {
  const track = index.track.get(s.field);
  const is_done = state.done.skills.has(s.id);
  const books_html = s.books.length
    ? book_link_chips(s.books)
    : '<p class="muted">（募集中）おすすめの本・資料があれば推薦してください。</p>';
  // 本があっても、もっと良い本を推薦できるようにリンクは常に出す
  const recommend_html = `<p class="recommend-line">${recommend_link_html(s.field, s, "＋ このスキルの本を推薦する")}</p>`;
  return `
    <p class="detail-kind">スキル</p>
    <div class="detail-chips">
      <span class="chip" style="--c:${escape_html(track.color)}">${escape_html(track.name)}</span>
      <span class="chip stage">${escape_html(track.common ? "共通基礎" : STAGE_NAMES[s.stage])}</span>
    </div>
    <h3 class="skill-title">${escape_html(s.title)}</h3>
    <h4>このスキルを学べる本</h4>${books_html}${recommend_html}
    <button type="button" class="toggle-done minor ${is_done ? "done" : ""}">${is_done ? "☑ 身についた（押すと外す）" : "□ 身についたにする"}</button>
    <h4>概要</h4><p>${escape_html(s.summary)}</p>
    <h4>習得する目的</h4><p>${escape_html(s.purpose)}</p>
    <h4>必要な前提知識</h4>${skill_list_html(s.prerequisites)}
    <h4>学ぶべき内容</h4>${list_html(s.learn)}
    <h4>使用するツール・ソフトウェア</h4>${list_html(s.tools)}
    <h4>実践課題</h4><p>${escape_html(s.exercise || "（未記入）")}</p>
    <h4>習得目標・到達基準</h4>${list_html(s.goal, "goal-list")}
    ${s.events?.length ? `<h4>関連する勉強会</h4>${list_html(s.events)}` : ""}
    <h4>次に進めるスキル</h4>${skill_list_html(index.skill_next.get(s.id) || [])}`;
}

// =============================================================
// 絞り込み
// =============================================================
function set_field_filter(field_id, force = false) {
  state.field_filter = (!force && state.field_filter === field_id) ? null : field_id;
  update_field_cards();
  render_board();
}

function update_field_cards() {
  document.querySelectorAll(".field-card").forEach((card) => {
    const active = card.dataset.field === state.field_filter;
    card.classList.toggle("active", active);
    card.classList.toggle("dimmed", Boolean(state.field_filter) && !active);
    card.setAttribute("aria-pressed", String(active));
  });
}

function setup_controls() {
  document.getElementById("show-all-btn").addEventListener("click", () => set_field_filter(null, true));
  document.getElementById("reset-btn").addEventListener("click", reset_all_done);
  document.addEventListener("keydown", (event) => { if (event.key === "Escape") close_detail(); });

  // 表の大きさが変わったら（画面の幅を変えた・フォントが読み込まれた など）矢印を描き直す
  const observer = new ResizeObserver(schedule_redraw_edges);
  observer.observe(document.getElementById("board"));
  window.addEventListener("resize", schedule_redraw_edges);
}

// =============================================================
// はじまり
// =============================================================
async function main() {
  try {
    if (typeof jsyaml === "undefined") {
      throw new Error("js-yaml（YAML を読むライブラリ）を読み込めませんでした。インターネットにつながっているか確かめてください。");
    }
    await load_all_data();
    build_index_and_validate();
    load_done();
    render_field_cards();
    render_process();
    setup_controls();
    setup_recommend_dialog();
    render_board();
  } catch (error) {
    show_error(error.message);
    console.error(error);
  }
}

main();

# Issue tracker: GitHub

本專案的議題與規格存放於 GitHub Issues，所有操作使用 `gh` CLI。

Repo：`github.com/danielrepublic/omo-psmux-bridge`（private）。`gh` 在此 clone 內會自動推斷目標 repo。

## 慣例

- **建立議題**：`gh issue create --title "..." --body "..."`。多行內文使用 heredoc。
- **讀取議題**：`gh issue view <number> --comments`，並用 `jq` 過濾留言，同時抓取 labels。
- **列出議題**：`gh issue list --state open --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'`，搭配適當的 `--label` 與 `--state` 過濾。
- **留言**：`gh issue comment <number> --body "..."`
- **套用 / 移除標籤**：`gh issue edit <number> --add-label "..."` / `--remove-label "..."`
- **關閉**：`gh issue close <number> --comment "..."`

從 `git remote -v` 推斷 repo；在 clone 內執行時 `gh` 會自動處理。

## Pull requests as a triage surface

**PRs as a request surface: no.** _（若此 repo 將外部 PR 視為功能需求，改為 `yes`；`/triage` 會讀取此旗標。）_

設為 `yes` 時，PR 會走與議題相同的標籤與狀態流程，使用 `gh pr` 對應指令：

- **讀取 PR**：`gh pr view <number> --comments`，diff 用 `gh pr diff <number>`。
- **列出待 triage 的外部 PR**：`gh pr list --state open --json number,title,body,labels,author,authorAssociation,comments`，只保留 `authorAssociation` 為 `CONTRIBUTOR`、`FIRST_TIME_CONTRIBUTOR` 或 `NONE`（丟棄 `OWNER`/`MEMBER`/`COLLABORATOR`）。
- **留言 / 標籤 / 關閉**：`gh pr comment`、`gh pr edit --add-label`/`--remove-label`、`gh pr close`。

GitHub 的 issue 與 PR 共用編號空間，因此單純的 `#42` 可能是任一者：先用 `gh pr view 42`，失敗則退回 `gh issue view 42`。

## 當 skill 說「publish to the issue tracker」

建立一個 GitHub issue。

## 當 skill 說「fetch the relevant ticket」

執行 `gh issue view <number> --comments`。

## Wayfinding 作業

供 `/wayfinder` 使用。**map** 是單一 issue，**child** issue 作為 tickets。

- **Map**：一個帶 `wayfinder:map` 標籤的 issue，容納 Notes / Decisions-so-far / Fog 內容。`gh issue create --label wayfinder:map`。
- **Child ticket**：以 GitHub sub-issue 形式連到 map 的 issue（對 sub-issues endpoint 呼叫 `gh api`）。若尚未啟用 sub-issues，則把 child 加入 map 內文的 task list，並在 child 內文開頭標註 `Part of #<map>`。標籤：`wayfinder:<type>`（`research`/`prototype`/`grilling`/`task`）。Claim 後指派給主導開發者。
- **Blocking**：優先使用 GitHub **原生 issue dependencies**（UI 可見的標準呈現）。加入依賴邊：`gh api --method POST repos/<owner>/<repo>/issues/<child>/dependencies/blocked_by -F issue_id=<blocker-db-id>`，其中 `<blocker-db-id>` 是阻擋項的**數字資料庫 id**（`gh api repos/<owner>/<repo>/issues/<n> --jq .id`，_不是_ `#number` 或 `node_id`）。GitHub 以 `issue_dependencies_summary.blocked_by` 回報（僅計未關閉的阻擋項，即實時閘門）。若無法使用 dependencies，退回在 child 內文開頭寫 `Blocked by: #<n>, #<n>`。所有阻擋項關閉後，ticket 即解鎖。
- **Frontier query**：列出 map 的未關閉 children（`gh issue list --state open`，範圍限 map 的 sub-issues / task list），丟棄有未關閉阻擋項（`issue_dependencies_summary.blocked_by > 0`，或 `Blocked by` 列中有未關閉議題）或已有 assignee 者；依 map 順序取第一個。
- **Claim**：`gh issue edit <n> --add-assignee @me`，這是 session 的第一次寫入。
- **Resolve**：`gh issue comment <n> --body "<answer>"`，接著 `gh issue close <n>`，最後把 context 指標（gist + 連結）附加到 map 的 Decisions-so-far。

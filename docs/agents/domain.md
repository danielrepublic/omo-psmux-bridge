# Domain Docs

工程 skills 在探索此 repo 時，應如何讀取本專案的領域文件。

## 探索前先讀這些

- **根目錄的 `CONTEXT.md`**，或
- **根目錄的 `CONTEXT-MAP.md`**（若存在）：它指向每個 context 各自的 `CONTEXT.md`，讀取與當前主題相關的那些。
- **`docs/adr/`**：讀取與你即將處理的區域相關的 ADR。multi-context repo 另外檢查 `src/<context>/docs/adr/` 是否有 context 範圍內的決策。

若上述任一檔案不存在，**靜默繼續**。不要指出它們缺失，也不要事先建議建立。`/domain-modeling` skill（由 `/grill-with-docs` 與 `/improve-codebase-architecture` 進入）會在術語或決策真正被釐清時才建立這些檔案。

## 檔案結構

本 repo 為 single-context：

```
/
├── CONTEXT.md
├── docs/adr/
│   ├── 0001-event-sourced-orders.md
│   └── 0002-postgres-for-write-model.md
└── src/
```

若日後出現 `CONTEXT-MAP.md`，代表轉為 multi-context，結構如下：

```
/
├── CONTEXT-MAP.md
├── docs/adr/                          ← 系統層級決策
└── src/
    ├── ordering/
    │   ├── CONTEXT.md
    │   └── docs/adr/                  ← context 專屬決策
    └── billing/
        ├── CONTEXT.md
        └── docs/adr/
```

## 使用 glossary 的詞彙

當你的輸出提到某個領域概念（議題標題、重構提案、假設、測試名稱），請使用 `CONTEXT.md` 中定義的詞彙。不要漂移到 glossary 明確排除的同義詞。

若所需的概念尚未出現在 glossary 中，這是一個訊號：可能你正在發明專案沒使用的語言（重新考慮），或確實存在缺口（記錄下來供 `/domain-modeling` 處理）。

## 標示 ADR 衝突

若你的輸出與既有 ADR 抵觸，請明確指出，而非默默推翻：

> _與 ADR-0007（event-sourced orders）抵觸，但值得重新討論，因為…_

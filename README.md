# ぷ庫OPAC

ぷ庫OPACの公開用リポジトリです。

## 日常更新

通常の更新では、リポジトリ直下の `UpdatePuko.cmd` を実行します。

`UpdatePuko.ps1` や `BuildPuko.ps1` は、日常更新では直接実行しません。

### 手順

1. Dropboxの同期を停止する
2. `UpdatePuko.cmd` を実行する
3. `Dropbox同期を停止しましたか？ [Y/N]` と表示されたら、停止を確認して `Y`
4. 必要に応じて改名・移動候補の確認に答える
5. 最後に `RESULT=SUCCESS` および `Puko OPAC update completed successfully.` を確認する
6. Dropboxの同期を再開する
7. contentに変更があった場合は、GitHub Pagesの更新完了を確認する

DailyUpdateは、保存済みのbuild stateと現在の環境を確認し、安全条件を満たす場合は差分Build（DIFF）、満たさない場合はFULL Buildを自動で選択します。利用者がDIFF/FULLを指定する必要はありません。

## ファイル名変更・フォルダ移動

原典ファイルのファイル名変更やフォルダ移動は可能です。

旧パスと新パスの内容が同一である場合、DailyUpdateは改名・移動候補として検出し、既存のOPAC_IDを新パスへ引き継ぐか確認します。

表示された `FROM` / `TO` / `OPAC_ID` が意図した変更と一致していることを確認してから `Y` を入力します。

### 安全な変更方法

改名・移動を行う更新では、原則として本文内容は変更しません。

1. 先にファイル名変更・フォルダ移動だけを行う
2. `UpdatePuko.cmd` を実行してOPAC_IDを引き継ぐ
3. 本文も修正する必要がある場合は、その後の別更新で修正する

フォルダ移動とファイル名変更を同時に行うこともできます。

対応関係を一意に決められない場合は安全停止します。

## 削除

原典ファイルの純粋な削除は、改名・移動とは別扱いです。

DailyUpdateは削除候補を自動適用せず、安全のため停止します。

意図的な削除を行う場合は、停止ログを確認して別途処理します。

## 正式state

DailyUpdateが使用する正式stateは次の場所にあります。

`%LOCALAPPDATA%\PukoUpdate\state`

主なファイル:

- `opac-source-state.json`
- `opac-build-state.json`

これらは通常運用に必要なため、削除しません。

バックアップは次の場所に保存されます。

`%LOCALAPPDATA%\PukoUpdate\backups`

## ログ

DailyUpdateのログは次の場所に保存されます。

`%LOCALAPPDATA%\PukoUpdate\logs`

更新が停止・失敗した場合は、ログの `RESULT`、`STAGE`、`REASON` を確認します。
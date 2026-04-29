# SillyTavern-PresetHistory 📸

> 给你的预设加上"撤销"功能。

每次保存预设时自动备份，可以一键回到任何一个历史版本。

## 这玩意儿能干啥

- 你不小心删了某个条目 → 退回去
- 你不小心改了顺序 → 退回去
- 你导入了一个同名预设把自己的覆盖了 → 退回去
- 你折腾了一晚上发现不如最开始 → 退回去

## 安装

1. 打开 SillyTavern
2. 点 **Extensions** → **Install Extension**
3. 粘贴：
   ```
   https://github.com/Elvisfor99/SillyTavern-PresetHistory
   ```
4. 点 Install，搞定

## 怎么用

装完之后扩展面板里会多一个 **📸 Preset History**，展开来：

- **Auto-snapshot on save** —— 打开这个开关，以后什么都不用管，每次你保存预设它会偷偷备份。
- **Max snapshots per preset** —— 每个预设最多保留多少个历史版本。默认30，超了自动删最老的。
- **📸 Snapshot Current State Now** —— 手动备份按钮。改大动作之前可以点一下，加个备注。

要回退的时候，往下翻到 **Snapshot History**，选预设类型 → 选预设名字 → 在列表里挑一个版本，点 ⏪ 就回退了。

## 兼容性

- SillyTavern 1.13+ 应该都能用（包括1.14、1.15、1.16、1.17）
- 走的是浏览器层面的拦截，不依赖具体的ST版本API

## License

AGPLv3

## 作者

Elvis & 小九，给酒馆社区的礼物 ✨

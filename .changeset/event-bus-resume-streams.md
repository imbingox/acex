---
"@imbingox/acex": patch
---

修复内部事件流和恢复流程：`AsyncEventBus` 的并发 `next()` pending reader 现在按 FIFO 队列唤醒，`close()` 会结束全部等待中的 reader；market `resumeStreams()` 改为并发恢复订阅，并保留每条流自己的错误隔离。

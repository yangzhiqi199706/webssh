-- 信创短信猫告警解除监测优化
-- 目的：支持 WHERE CancelTime + id 复合游标，避免解除轮询全表扫描。
-- 执行前请确认目标库、维护窗口和磁盘空间；本文件不会被 webssh 自动执行。
ALTER TABLE `dcim-alarmlist`
  ADD INDEX `idx_alarmlist_cancel_feed` (`CancelTime`, `id`);

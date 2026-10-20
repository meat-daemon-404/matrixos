-- MatrixOS 数据库初始化
-- 在 postgres 容器首次启动时自动执行
-- 幂等：可重复执行

-- pgvector 扩展（资产图谱的向量检索依赖）
CREATE EXTENSION IF NOT EXISTS vector;

-- 模糊匹配（导师名、论文标题检索）
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- UUID 生成
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- 确认
DO $$
BEGIN
  RAISE NOTICE 'MatrixOS init: vector / pg_trgm / uuid-ossp ready';
END $$;

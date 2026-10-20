"""matrix-core：MatrixOS v3.0 的身份与资产平面。

对标工作分解：
- S1-06 工程骨架（分层 / 依赖注入 / 统一错误 / OpenAPI 导出）
- S1-08 MatrixID 鉴权（OAuth2 授权码 + RS256 JWT + refresh 轮转 + jti 黑名单）
- S1-09 introspect / exchange（mx_idt 一次性交换）
- S1-10 数据模型与 Alembic 迁移（asset_node / asset_edge / asset_chunk + HNSW）
- S1-11 资产 CRUD 与向量检索 + scope 权限校验
- S1-12 资产图谱边推断
"""

__version__ = "0.1.0"

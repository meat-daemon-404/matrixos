"""Embedding 提供者。

ADR-04 只锁定了「维度 1024 + pgvector」，没有锁定 embedding 模型；而本服务的
职责是**存取**向量，不是训练模型。因此：

- 默认 ``hashing``：确定性、离线、零依赖的 char-ngram 哈希向量。
  作用是把「检索通路」端到端跑通并可被单测覆盖；它**不是**语义模型，
  README 的「已知边界」里明确写了这一点；
- 生产应把 ``MATRIX_CORE_EMBEDDING_PROVIDER`` 指向真实 provider，
  通过同一 ``EmbeddingProvider`` 接口注入（改一处即可，不影响上层 SQL）。

维度必须恒为 1024（``vector(1024)`` 是列定义，换维度要迁移，见 ADR-04）。
"""

from __future__ import annotations

import hashlib
import math
import re
from abc import ABC, abstractmethod
from functools import lru_cache

from app.core.config import get_settings

_TOKEN_RE = re.compile(r"[a-z0-9]+", re.IGNORECASE)
_CJK_RE = re.compile(r"[\u4e00-\u9fff]")


def _normalize(vector: list[float]) -> list[float]:
    norm = math.sqrt(sum(value * value for value in vector))
    if norm == 0.0:
        return vector
    return [value / norm for value in vector]


class EmbeddingProvider(ABC):
    """向量化接口。实现方必须保证输出长度 == ``dim``。"""

    name: str = "abstract"

    def __init__(self, dim: int) -> None:
        self.dim = dim

    @abstractmethod
    def embed(self, text: str) -> list[float]:
        """把文本编码成 ``dim`` 维、L2 归一化的向量。"""

    def embed_batch(self, texts: list[str]) -> list[list[float]]:
        return [self.embed(text) for text in texts]


class HashingEmbeddingProvider(EmbeddingProvider):
    """确定性哈希向量：字符 n-gram + 词元哈希到固定维度。

    特征：
    - 相同文本恒定输出相同向量（可重放、可做单测断言）；
    - 共享词元越多，余弦相似度越高——足以验证「检索链路 + 排序 + 权限过滤」；
    - 无网络、无模型、无随机性。
    """

    name = "hashing-ngram-v1"

    def __init__(self, dim: int = 1024, ngram: int = 3) -> None:
        super().__init__(dim)
        self.ngram = ngram

    def _tokens(self, text: str) -> list[str]:
        lowered = text.lower()
        tokens = _TOKEN_RE.findall(lowered)
        # 中文按字 + 二元组切分（无分词器依赖）
        cjk = _CJK_RE.findall(lowered)
        tokens.extend(cjk)
        for index in range(len(cjk) - 1):
            tokens.append(cjk[index] + cjk[index + 1])
        # 字符 n-gram 提升短文本区分度
        for token in list(tokens):
            if len(token) > self.ngram:
                for start in range(len(token) - self.ngram + 1):
                    tokens.append(token[start : start + self.ngram])
        return tokens

    def _bucket(self, token: str) -> tuple[int, float]:
        digest = hashlib.blake2b(token.encode("utf-8"), digest_size=8).digest()
        raw = int.from_bytes(digest, "big")
        index = raw % self.dim
        sign = 1.0 if (raw >> 63) & 1 else -1.0
        return index, sign

    def embed(self, text: str) -> list[float]:
        vector = [0.0] * self.dim
        tokens = self._tokens(text or "")
        if not tokens:
            return vector
        for token in tokens:
            index, sign = self._bucket(token)
            vector[index] += sign
        return _normalize([round(value, 6) for value in vector])


_PROVIDERS: dict[str, type[EmbeddingProvider]] = {
    "hashing": HashingEmbeddingProvider,
}


def register_provider(name: str, provider_cls: type[EmbeddingProvider]) -> None:
    """供后续接入真实 embedding 服务时注册（无需改本模块逻辑）。"""
    _PROVIDERS[name] = provider_cls


@lru_cache(maxsize=4)
def _build_provider(name: str, dim: int) -> EmbeddingProvider:
    provider_cls = _PROVIDERS.get(name, HashingEmbeddingProvider)
    return provider_cls(dim=dim)


def get_embedding_provider() -> EmbeddingProvider:
    settings = get_settings()
    return _build_provider(settings.embedding_provider, settings.embedding_dim)


def cosine_similarity(left: list[float], right: list[float]) -> float:
    """余弦相似度（用于非 PostgreSQL 方言的降级路径与单测断言）。"""
    if not left or not right or len(left) != len(right):
        return 0.0
    dot = sum(a * b for a, b in zip(left, right, strict=True))
    left_norm = math.sqrt(sum(a * a for a in left))
    right_norm = math.sqrt(sum(b * b for b in right))
    if left_norm == 0.0 or right_norm == 0.0:
        return 0.0
    return dot / (left_norm * right_norm)


def chunk_text(text: str, *, size: int, overlap: int) -> list[str]:
    """按字符切分（``size`` 与 ``overlap`` 来自配置），空文本返回空列表。"""
    cleaned = (text or "").strip()
    if not cleaned:
        return []
    if size <= 0:
        return [cleaned]
    step = max(1, size - max(0, overlap))
    chunks: list[str] = []
    for start in range(0, len(cleaned), step):
        piece = cleaned[start : start + size].strip()
        if piece:
            chunks.append(piece)
        if start + size >= len(cleaned):
            break
    return chunks

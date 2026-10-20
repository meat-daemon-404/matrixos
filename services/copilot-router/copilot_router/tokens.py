"""Token 估算。

为什么需要估算：路由的第一维是输入长度（ADR-06），预算预检必须在**调用之前**
就知道大概要花多少钱（否则超支已成事实）。但真实 token 数只有上游返回的
``usage`` 才准确，因此：

- **计费与出账**一律使用上游返回的 ``usage``（``billing.py``）；
- **路由分档与预算预检**使用本模块的估算（保守偏高，宁可拦早不拦晚）。

估算口径（中英混排，偏保守）：
- CJK 字符（含中日韩统一表意文字、全角标点）：按 **1 token / 字**，
  这是 DeepSeek / Qwen 系中文分词的实际量级；
- 其余 ASCII 段：按 **4 字符 / token**（GPT 系 BPE 的常用经验值，
  对代码与英文论文摘要偏保守）；
- 每条消息额外 **4 token** 的角色与分隔开销；
- 整个请求额外 **3 token** 的回复引导开销。

若将来接入 tiktoken 或上游的 tokenizer，只需替换 ``estimate_text_tokens``，
上层无需改动。
"""

from __future__ import annotations

import re

#: CJK 及全角标点区间
_CJK_RE = re.compile(
    r"[\u3040-\u30ff"  # 日文假名
    r"\u3400-\u4dbf"  # CJK 扩展 A
    r"\u4e00-\u9fff"  # CJK 基本区
    r"\uf900-\ufaff"  # CJK 兼容表意文字
    r"\uff00-\uffef"  # 全角 ASCII / 半角片假名 / 全角标点
    r"]"
)
_PER_MESSAGE_OVERHEAD = 4
_REPLY_PRIMER_TOKENS = 3


def _is_cjk(ch: str) -> bool:
    return bool(_CJK_RE.match(ch))


def estimate_text_tokens(text: str) -> int:
    """估算一段文本的 token 数（不含消息封装开销）。"""
    if not text:
        return 0
    cjk_count = 0
    ascii_run = 0
    total = 0
    for ch in text:
        if _is_cjk(ch):
            cjk_count += 1
            if ascii_run:
                # 非 CJK 段按 4 字符 / token 向上取整
                total += (ascii_run + 3) // 4
                ascii_run = 0
        else:
            ascii_run += 1
    if ascii_run:
        total += (ascii_run + 3) // 4
    return total + cjk_count


def estimate_messages_tokens(messages: list[tuple[str, str]]) -> int:
    """估算整组消息的 prompt token 数。

    ``messages`` 是 ``(role, content)`` 元组列表，与 ``types.ChatMessage`` 解耦，
    便于测试与复用。
    """
    total = _REPLY_PRIMER_TOKENS
    for _role, content in messages:
        total += _PER_MESSAGE_OVERHEAD + estimate_text_tokens(content)
    return max(total, 1)


def length_bucket(
    prompt_tokens: int,
    *,
    short_max: int,
    medium_max: int,
    long_max: int,
) -> str:
    """把 token 数映射到长度分档：short / medium / long / overlong。

    分档本身不含路由策略，策略在 ``routing.py`` —— 这样调阈值不必改逻辑。
    """
    if prompt_tokens <= short_max:
        return "short"
    if prompt_tokens <= medium_max:
        return "medium"
    if prompt_tokens <= long_max:
        return "long"
    return "overlong"

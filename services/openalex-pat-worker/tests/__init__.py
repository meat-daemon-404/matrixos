"""openalex-pat-worker 测试包。

存在这个文件（而不是依赖 rootdir 隐式命名空间）的原因：
测试之间通过 ``from .conftest import ...`` 共享构造器，相对 import 需要包上下文。
"""

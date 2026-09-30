from typing import Generic, TypeVar
T = TypeVar('T')
def decorate(fn):
    return fn
class Base:
    pass
@decorate
class Service(Base):
    @decorate
    def load(self, key: str) -> str:
        return helper(key)
def helper(key: str) -> str:
    return key.upper()
def ambiguous():
    return unknown.load()
type Items[T] = list[T]

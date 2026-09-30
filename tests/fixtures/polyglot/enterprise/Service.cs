namespace Example;
using System;
interface ILoader { string Load(); }
record Item(string Name);
class Service<T> : ILoader {
  public Service() {}
  [Obsolete] public string Load() { return Helper(); }
  private string Helper() { return "ok"; }
}

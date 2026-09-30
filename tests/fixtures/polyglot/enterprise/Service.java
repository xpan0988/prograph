package example;
import java.util.List;
interface Loader { String load(); }
record Item(String name) {}
class Service implements Loader {
  public Service() {}
  @Override public String load() { return helper(); }
  private String helper() { return "ok"; }
}

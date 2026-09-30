#include "api.h"
namespace example {
class Base {};
template<typename T> class Service : public Base {
public:
  T load(T value) { return value; }
};
int run_cpp() { Service<int> service; return service.load(3); }
}

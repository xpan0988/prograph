#include "api.h"
#define VALUE 3
int helper(int value) { return value; }
int run(int value) { return helper(value) + VALUE; }

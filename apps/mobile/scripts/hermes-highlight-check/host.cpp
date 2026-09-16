#include <hermes/hermes.h>
#include <jsi/jsi.h>
#include <fstream>
#include <iostream>
#include <sstream>
using namespace facebook;
int main(int argc, char **argv) {
  if (argc < 2) { std::cerr << "usage: host file.js\n"; return 2; }
  std::ifstream f(argv[1]); std::stringstream ss; ss << f.rdbuf();
  auto config = ::hermes::vm::RuntimeConfig::Builder().withMicrotaskQueue(true).build();
  auto rt = facebook::hermes::makeHermesRuntime(config);
  auto &r = *rt;
  r.global().setProperty(r, "print", jsi::Function::createFromHostFunction(r, jsi::PropNameID::forAscii(r, "print"), 1,
    [](jsi::Runtime &rt, const jsi::Value &, const jsi::Value *args, size_t n) -> jsi::Value {
      for (size_t i = 0; i < n; i++) { std::cout << (i ? " " : "") << args[i].toString(rt).utf8(rt); }
      std::cout << std::endl; return jsi::Value::undefined(); }));
  try {
    r.evaluateJavaScript(std::make_shared<jsi::StringBuffer>(ss.str()), argv[1]);
    for (int i = 0; i < 1000; i++) r.drainMicrotasks();
  } catch (jsi::JSError &e) { std::cerr << "JSError: " << e.getMessage() << "\n" << e.getStack() << "\n"; return 1; }
  catch (std::exception &e) { std::cerr << "ERR: " << e.what() << "\n"; return 1; }
  return 0;
}

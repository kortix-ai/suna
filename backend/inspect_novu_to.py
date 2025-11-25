import novu_py

print("To definition:")
# 'To' seems to be a type alias or class.
# Based on the previous ls output, 'To' was in the dir(novu_py).
if hasattr(novu_py, 'To'):
    print(novu_py.To)
    # If it is a TypeAlias or Union, we can inspect it.
    try:
        print(novu_py.To.__args__)
    except:
        pass
else:
    print("To not found in novu_py")

# Let's check what To can be.


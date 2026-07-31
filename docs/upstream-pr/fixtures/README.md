# Fixture provenance

Reuses pb-codegraph task 001's Magento fixture tree
(`tests/fixture/app/code/Acme/` in this repo) as its base, per this task's
instruction to reuse that tree rather than invent an unrelated one. Files are
marked below as either a verbatim copy or new-for-this-PR.

| File | Provenance |
|---|---|
| `composer.json` | New — project-root manifest for `detect()`'s composer.json signal (task 001's fixture has none). |
| `app/code/Acme/ModuleA/Api/FooInterface.php` | Verbatim copy of `tests/fixture/app/code/Acme/ModuleA/Api/FooInterface.php`. |
| `app/code/Acme/ModuleA/Model/Foo.php` | Verbatim copy of `tests/fixture/app/code/Acme/ModuleA/Model/Foo.php` — the `webapi.xml` resolve target (`Acme\ModuleA\Model\Foo::getFoo`). |
| `app/code/Acme/ModuleB/registration.php` | Verbatim copy of `tests/fixture/app/code/Acme/ModuleB/registration.php`. |
| `app/code/Acme/ModuleB/etc/module.xml` | Verbatim copy of `tests/fixture/app/code/Acme/ModuleB/etc/module.xml`. |
| `app/code/Acme/ModuleB/etc/frontend/routes.xml` | Verbatim copy of `tests/fixture/app/code/Acme/ModuleB/etc/frontend/routes.xml` — exercises the frontend route family. |
| `app/code/Acme/ModuleB/etc/webapi.xml` | Verbatim copy of `tests/fixture/app/code/Acme/ModuleB/etc/webapi.xml` — exercises the webapi route family. |
| `app/code/Acme/ModuleB/etc/adminhtml/routes.xml` | New — adminhtml-area counterpart to the frontend routes.xml, exercising the area half of spec §4.2. |
| `app/code/Acme/ModuleB/Controller/Index/Index.php` | New — frontend default-action controller (spec §4.2's `index/index` elision case). |
| `app/code/Acme/ModuleB/Controller/Adminhtml/Widget/Edit.php` | New — adminhtml controller (spec §4.2's area-prefix-stripping case). |

Task 001's original fixture tree (`tests/fixture/app/code/Acme/`) additionally
carries `di.xml`, `events.xml`, a plugin class, and a layout/template pair —
those are out of scope for this recognizer (routing only; see
`docs/upstream-pr/src/magento.ts`'s "Design decisions" section) and are not
duplicated here.

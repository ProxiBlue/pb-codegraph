<?php
namespace Acme\ModuleA\Plugin;

use Acme\ModuleA\Model\Foo;

class FooPlugin
{
    public function afterGetFoo(Foo $subject, string $result): string
    {
        return $result . '-plugged';
    }
}

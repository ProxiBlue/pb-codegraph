<?php
namespace Acme\ModuleA\Model;

use Acme\ModuleA\Api\FooInterface;

class Foo implements FooInterface
{
    public function getFoo(): string
    {
        return 'foo';
    }
}

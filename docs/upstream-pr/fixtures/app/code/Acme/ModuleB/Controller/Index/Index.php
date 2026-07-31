<?php
// New for this PR — demonstrates the frontend default-action elision case
// (spec §4.2 point 2, §4.1's "index/index" example): reachable at the bare
// `/moduleb` in addition to `/moduleb/index/index` once the postExtract pass
// joins this class's route against the frontName declared in the sibling
// etc/frontend/routes.xml fixture.
namespace Acme\ModuleB\Controller\Index;

use Magento\Framework\App\Action\Action;
use Magento\Framework\App\Action\Context;
use Magento\Framework\Controller\ResultFactory;

class Index extends Action
{
    public function __construct(Context $context)
    {
        parent::__construct($context);
    }

    public function execute()
    {
        return $this->resultFactory->create(ResultFactory::TYPE_PAGE);
    }
}

<?php
// New for this PR — demonstrates the adminhtml area convention (spec §4.2):
// reachable at /moduleb/widget/edit under the admin area once the
// postExtract pass joins this class's route against the frontName declared
// in the sibling etc/adminhtml/routes.xml fixture. The `Adminhtml` path
// segment is stripped from the URL (it identifies the area, not a URL
// segment) per controllerPathSegments' area-detection rule.
namespace Acme\ModuleB\Controller\Adminhtml\Widget;

use Magento\Backend\App\Action;
use Magento\Backend\App\Action\Context;
use Magento\Framework\Controller\ResultFactory;

class Edit extends Action
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

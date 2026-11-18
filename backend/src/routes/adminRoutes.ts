import { Router } from 'express';
import { auditAction } from '../middlewares/auditMiddleware';
import { AdminController } from '../controllers/AdminController';
import { requireAdmin } from '../middlewares/authMiddleware';

const router = Router();

router.use(requireAdmin);

router.get('/', AdminController.listAdmins);
router.post('/', auditAction('ADMIN', 'Ustawiono uprawnienia administratora', (req) => req.body?.username), AdminController.createAdmin);
router.delete('/:username', auditAction('ADMIN', 'Odebrano uprawnienia administratora', (req) => req.params.username), AdminController.deleteAdmin);

export default router;

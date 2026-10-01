import { Router, type IRouter } from "express";
import healthRouter from "./health";
import clipwiseRouter from "./clipwise";
import mcpRouter from "./mcp";
import storageRouter from "./storage";
import billingRouter from "./billing";

const router: IRouter = Router();

router.use(healthRouter);
router.use(mcpRouter);
router.use(storageRouter);
router.use(billingRouter);
router.use(clipwiseRouter);

export default router;

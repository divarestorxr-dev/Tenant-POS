# Tenant POS DEV working guidance

Read the [CST Global Development SOP](https://github.com/Travelintrips/Core-AI-Foundation/blob/develop/CST-GLOBAL-DEVELOPMENT-SOP.md) before classifying a job. Record the SOP version and source commit alongside the Tenant POS commit and evidence.

Use authorized DEV sessions and scoped test tenants. Verify reminders and manual sends through existing flows. Use authorized test destinations and verify that retries do not duplicate outbound messages. Use fixtures for payments and accounting effects.

Use the existing Release Gate and DEV regression workflow where applicable. Record runtime evidence separately from CI. Production changes require explicit owner approval.

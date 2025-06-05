-- shared/database/init.sql
-- EDMS Database Initialization Script

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ===============================
-- USERS AND AUTHENTICATION
-- ===============================

-- Users table
CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    username VARCHAR(100) UNIQUE NOT NULL,
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    first_name VARCHAR(100),
    last_name VARCHAR(100),
    is_active BOOLEAN DEFAULT true,
    last_login TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- Roles table
CREATE TABLE roles (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(50) UNIQUE NOT NULL,
    description TEXT,
    permissions JSONB,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- User roles junction table
CREATE TABLE user_roles (
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    role_id UUID REFERENCES roles(id) ON DELETE CASCADE,
    assigned_at TIMESTAMP DEFAULT NOW(),
    assigned_by UUID REFERENCES users(id),
    PRIMARY KEY (user_id, role_id)
);

-- ===============================
-- PROJECTS AND DOCUMENT TYPES
-- ===============================

-- Projects table
CREATE TABLE projects (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(255) NOT NULL,
    description TEXT,
    status VARCHAR(50) DEFAULT 'active',
    start_date DATE,
    end_date DATE,
    created_by UUID REFERENCES users(id),
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- Document types table
CREATE TABLE document_types (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(100) NOT NULL,
    description TEXT,
    allowed_extensions TEXT[],
    max_size_mb INTEGER DEFAULT 100,
    requires_approval BOOLEAN DEFAULT false,
    retention_period_months INTEGER,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- ===============================
-- DOCUMENTS
-- ===============================

-- Documents table
CREATE TABLE documents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID REFERENCES projects(id),
    document_type_id UUID REFERENCES document_types(id),
    title VARCHAR(255) NOT NULL,
    description TEXT,
    file_name VARCHAR(255) NOT NULL,
    file_size BIGINT,
    mime_type VARCHAR(100),
    minio_path VARCHAR(500) NOT NULL,
    checksum VARCHAR(64),
    current_version INTEGER DEFAULT 1,
    uploaded_by UUID REFERENCES users(id),
    status VARCHAR(50) DEFAULT 'draft', -- draft, review, approved, archived
    metadata JSONB,
    tags TEXT[],
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- Document versions table
CREATE TABLE document_versions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    document_id UUID REFERENCES documents(id) ON DELETE CASCADE,
    version_number INTEGER NOT NULL,
    file_name VARCHAR(255) NOT NULL,
    file_size BIGINT,
    minio_path VARCHAR(500) NOT NULL,
    checksum VARCHAR(64),
    changes_description TEXT,
    uploaded_by UUID REFERENCES users(id),
    created_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(document_id, version_number)
);

-- Version relationships (for tracking dependencies)
CREATE TABLE version_relationships (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    parent_version_id UUID REFERENCES document_versions(id),
    child_version_id UUID REFERENCES document_versions(id),
    relationship_type VARCHAR(50), -- supersedes, references, merges
    created_at TIMESTAMP DEFAULT NOW()
);

-- Document access permissions
CREATE TABLE document_permissions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    document_id UUID REFERENCES documents(id) ON DELETE CASCADE,
    user_id UUID REFERENCES users(id),
    role_id UUID REFERENCES roles(id),
    permission_type VARCHAR(50) NOT NULL, -- read, write, delete, approve
    granted_by UUID REFERENCES users(id),
    granted_at TIMESTAMP DEFAULT NOW(),
    expires_at TIMESTAMP,
    CONSTRAINT chk_user_or_role CHECK (
        (user_id IS NOT NULL AND role_id IS NULL) OR 
        (user_id IS NULL AND role_id IS NOT NULL)
    )
);

-- ===============================
-- WORKFLOW MANAGEMENT
-- ===============================

-- Workflow templates
CREATE TABLE workflow_templates (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(255) NOT NULL,
    description TEXT,
    document_type_id UUID REFERENCES document_types(id),
    workflow_config JSONB NOT NULL,
    is_active BOOLEAN DEFAULT true,
    created_by UUID REFERENCES users(id),
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- Workflow instances
CREATE TABLE workflow_instances (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    document_id UUID REFERENCES documents(id),
    template_id UUID REFERENCES workflow_templates(id),
    current_step INTEGER DEFAULT 1,
    status VARCHAR(50) DEFAULT 'pending', -- pending, in_progress, completed, cancelled
    initiated_by UUID REFERENCES users(id),
    started_at TIMESTAMP DEFAULT NOW(),
    completed_at TIMESTAMP,
    due_date TIMESTAMP,
    priority VARCHAR(20) DEFAULT 'normal' -- low, normal, high, urgent
);

-- Approval steps
CREATE TABLE approval_steps (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workflow_instance_id UUID REFERENCES workflow_instances(id),
    step_number INTEGER NOT NULL,
    step_name VARCHAR(255),
    approver_user_id UUID REFERENCES users(id),
    approver_role_id UUID REFERENCES roles(id),
    status VARCHAR(50) DEFAULT 'pending', -- pending, approved, rejected, delegated
    comments TEXT,
    approved_at TIMESTAMP,
    delegated_to UUID REFERENCES users(id),
    due_date TIMESTAMP,
    CONSTRAINT chk_approver CHECK (
        (approver_user_id IS NOT NULL AND approver_role_id IS NULL) OR 
        (approver_user_id IS NULL AND approver_role_id IS NOT NULL)
    )
);

-- ===============================
-- SEARCH AND INDEXING
-- ===============================

-- Search indexes for full-text search
CREATE TABLE search_indexes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    document_id UUID REFERENCES documents(id) ON DELETE CASCADE,
    content_vector tsvector,
    metadata_vector tsvector,
    indexed_at TIMESTAMP DEFAULT NOW()
);

-- Create GIN indexes for performance
CREATE INDEX idx_search_content ON search_indexes USING GIN(content_vector);
CREATE INDEX idx_search_metadata ON search_indexes USING GIN(metadata_vector);

-- Saved searches
CREATE TABLE saved_searches (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id),
    name VARCHAR(255) NOT NULL,
    query_params JSONB NOT NULL,
    is_public BOOLEAN DEFAULT false,
    created_at TIMESTAMP DEFAULT NOW()
);

-- Search analytics
CREATE TABLE search_analytics (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id),
    query TEXT NOT NULL,
    filters JSONB,
    results_count INTEGER,
    execution_time_ms INTEGER,
    clicked_documents UUID[],
    searched_at TIMESTAMP DEFAULT NOW()
);

-- ===============================
-- NOTIFICATIONS
-- ===============================

-- Notification templates
CREATE TABLE notification_templates (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(255) NOT NULL,
    event_type VARCHAR(100) NOT NULL,
    subject_template TEXT,
    body_template TEXT,
    notification_type VARCHAR(50), -- email, sms, push, in_app
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMP DEFAULT NOW()
);

-- Notifications
CREATE TABLE notifications (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id),
    template_id UUID REFERENCES notification_templates(id),
    subject TEXT,
    message TEXT,
    notification_type VARCHAR(50), -- email, sms, push, in_app
    status VARCHAR(50) DEFAULT 'pending', -- pending, sent, failed, read
    data JSONB,
    sent_at TIMESTAMP,
    read_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW()
);

-- ===============================
-- AUDIT AND COMPLIANCE
-- ===============================

-- Audit logs
CREATE TABLE audit_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id),
    entity_type VARCHAR(100) NOT NULL,
    entity_id UUID NOT NULL,
    action VARCHAR(100) NOT NULL,
    old_values JSONB,
    new_values JSONB,
    ip_address INET,
    user_agent TEXT,
    session_id VARCHAR(255),
    timestamp TIMESTAMP DEFAULT NOW()
);

-- Compliance events
CREATE TABLE compliance_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    document_id UUID REFERENCES documents(id),
    event_type VARCHAR(100) NOT NULL,
    regulation_reference VARCHAR(255),
    compliance_status VARCHAR(50), -- compliant, non_compliant, pending_review
    evidence JSONB,
    reviewed_by UUID REFERENCES users(id),
    reviewed_at TIMESTAMP,
    recorded_at TIMESTAMP DEFAULT NOW()
);

-- Data retention policies
CREATE TABLE retention_policies (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    entity_type VARCHAR(100) NOT NULL,
    retention_period_months INTEGER NOT NULL,
    action_on_expiry VARCHAR(50) DEFAULT 'archive', -- archive, delete, flag
    is_active BOOLEAN DEFAULT true,
    created_by UUID REFERENCES users(id),
    created_at TIMESTAMP DEFAULT NOW()
);

-- ===============================
-- REPORTING
-- ===============================

-- Report definitions
CREATE TABLE report_definitions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(255) NOT NULL,
    description TEXT,
    report_type VARCHAR(100), -- compliance, activity, performance, custom
    query_template TEXT,
    parameters_schema JSONB,
    output_format VARCHAR(50) DEFAULT 'json', -- json, csv, pdf
    is_public BOOLEAN DEFAULT false,
    created_by UUID REFERENCES users(id),
    created_at TIMESTAMP DEFAULT NOW()
);

-- Report executions
CREATE TABLE report_executions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    report_definition_id UUID REFERENCES report_definitions(id),
    executed_by UUID REFERENCES users(id),
    parameters JSONB,
    status VARCHAR(50) DEFAULT 'running', -- running, completed, failed
    result_data JSONB,
    output_file_path VARCHAR(500),
    execution_time_ms INTEGER,
    started_at TIMESTAMP DEFAULT NOW(),
    completed_at TIMESTAMP
);

-- ===============================
-- INDEXES FOR PERFORMANCE
-- ===============================

-- Users indexes
CREATE INDEX idx_users_username ON users(username);
CREATE INDEX idx_users_email ON users(email);
CREATE INDEX idx_users_active ON users(is_active);

-- Documents indexes
CREATE INDEX idx_documents_project ON documents(project_id);
CREATE INDEX idx_documents_type ON documents(document_type_id);
CREATE INDEX idx_documents_status ON documents(status);
CREATE INDEX idx_documents_created_at ON documents(created_at);
CREATE INDEX idx_documents_tags ON documents USING GIN(tags);
CREATE INDEX idx_documents_metadata ON documents USING GIN(metadata);

-- Document versions indexes
CREATE INDEX idx_document_versions_document ON document_versions(document_id);
CREATE INDEX idx_document_versions_version ON document_versions(document_id, version_number);

-- Workflow indexes
CREATE INDEX idx_workflow_instances_document ON workflow_instances(document_id);
CREATE INDEX idx_workflow_instances_status ON workflow_instances(status);
CREATE INDEX idx_workflow_instances_due_date ON workflow_instances(due_date);

-- Approval steps indexes
CREATE INDEX idx_approval_steps_workflow ON approval_steps(workflow_instance_id);
CREATE INDEX idx_approval_steps_approver_user ON approval_steps(approver_user_id);
CREATE INDEX idx_approval_steps_status ON approval_steps(status);

-- Audit logs indexes
CREATE INDEX idx_audit_logs_user ON audit_logs(user_id);
CREATE INDEX idx_audit_logs_entity ON audit_logs(entity_type, entity_id);
CREATE INDEX idx_audit_logs_timestamp ON audit_logs(timestamp);
CREATE INDEX idx_audit_logs_action ON audit_logs(action);

-- Notifications indexes
CREATE INDEX idx_notifications_user ON notifications(user_id);
CREATE INDEX idx_notifications_status ON notifications(status);
CREATE INDEX idx_notifications_created_at ON notifications(created_at);

-- ===============================
-- INITIAL DATA
-- ===============================

-- Insert default roles
INSERT INTO roles (name, description, permissions) VALUES
('admin', 'System Administrator', '{"documents": ["create", "read", "update", "delete"], "users": ["create", "read", "update", "delete"], "workflow": ["create", "read", "update", "delete"], "reports": ["create", "read", "update", "delete"]}'),
('manager', 'Project Manager', '{"documents": ["create", "read", "update"], "workflow": ["create", "read", "update"], "reports": ["read"]}'),
('engineer', 'Engineer', '{"documents": ["create", "read", "update"], "workflow": ["read"]}'),
('viewer', 'Document Viewer', '{"documents": ["read"]}'),
('approver', 'Document Approver', '{"documents": ["read"], "workflow": ["approve"]}');

-- Insert default document types
INSERT INTO document_types (name, description, allowed_extensions, max_size_mb, requires_approval) VALUES
('CAD Drawing', 'Computer-Aided Design drawings', ARRAY['.dwg', '.dxf', '.step', '.iges'], 50, true),
('Technical Specification', 'Technical specification documents', ARRAY['.pdf', '.doc', '.docx'], 25, true),
('Geological Survey', 'Geological survey reports', ARRAY['.pdf', '.doc', '.docx', '.xls', '.xlsx'], 100, true),
('Drilling Report', 'Drilling operation reports', ARRAY['.pdf', '.doc', '.docx'], 50, true),
('Safety Document', 'Safety procedures and reports', ARRAY['.pdf', '.doc', '.docx'], 25, true),
('Project Plan', 'Project planning documents', ARRAY['.pdf', '.doc', '.docx', '.mpp'], 25, false),
('Technical Manual', 'Technical operation manuals', ARRAY['.pdf', '.doc', '.docx'], 100, false),
('Certificate', 'Certificates and compliance documents', ARRAY['.pdf'], 10, true);

-- Insert default project
INSERT INTO projects (name, description, status, created_by) VALUES
('Default Project', 'Default project for document organization', 'active', (SELECT id FROM users WHERE username = 'admin' LIMIT 1));

-- Insert default workflow templates
INSERT INTO workflow_templates (name, description, workflow_config, created_by) VALUES
('Standard Approval', 'Standard document approval workflow', 
 '{"steps": [{"step": 1, "name": "Technical Review", "approver_role": "engineer"}, {"step": 2, "name": "Manager Approval", "approver_role": "manager"}]}', 
 (SELECT id FROM users WHERE username = 'admin' LIMIT 1)),
('Safety Document Approval', 'Safety document approval workflow', 
 '{"steps": [{"step": 1, "name": "Safety Review", "approver_role": "approver"}, {"step": 2, "name": "Manager Approval", "approver_role": "manager"}, {"step": 3, "name": "Final Approval", "approver_role": "admin"}]}', 
 (SELECT id FROM users WHERE username = 'admin' LIMIT 1));

-- Insert notification templates
INSERT INTO notification_templates (name, event_type, subject_template, body_template, notification_type) VALUES
('Document Upload', 'document_uploaded', 'New Document Uploaded: {{document.title}}', 'A new document "{{document.title}}" has been uploaded to project {{project.name}}.', 'email'),
('Approval Required', 'approval_required', 'Document Approval Required: {{document.title}}', 'Document "{{document.title}}" requires your approval. Please review and approve/reject.', 'email'),
('Document Approved', 'document_approved', 'Document Approved: {{document.title}}', 'Document "{{document.title}}" has been approved and is now available.', 'email'),
('Document Rejected', 'document_rejected', 'Document Rejected: {{document.title}}', 'Document "{{document.title}}" has been rejected. Reason: {{reason}}', 'email');

-- Insert default report definitions
INSERT INTO report_definitions (name, description, report_type, query_template, created_by) VALUES
('Document Activity Report', 'Shows document upload and approval activity', 'activity', 
 'SELECT d.title, d.status, d.created_at, u.username FROM documents d JOIN users u ON d.uploaded_by = u.id WHERE d.created_at >= {{start_date}} AND d.created_at <= {{end_date}}',
 (SELECT id FROM users WHERE username = 'admin' LIMIT 1)),
('Compliance Status Report', 'Shows compliance status of documents', 'compliance',
 'SELECT d.title, d.status, ce.compliance_status FROM documents d LEFT JOIN compliance_events ce ON d.id = ce.document_id WHERE d.document_type_id = {{document_type_id}}',
 (SELECT id FROM users WHERE username = 'admin' LIMIT 1));

-- ===============================
-- FUNCTIONS AND TRIGGERS
-- ===============================

-- Function to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Add triggers for updated_at columns
CREATE TRIGGER update_users_updated_at BEFORE UPDATE ON users
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_roles_updated_at BEFORE UPDATE ON roles
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_projects_updated_at BEFORE UPDATE ON projects
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_document_types_updated_at BEFORE UPDATE ON document_types
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_documents_updated_at BEFORE UPDATE ON documents
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_workflow_templates_updated_at BEFORE UPDATE ON workflow_templates
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Function to create audit log entry
CREATE OR REPLACE FUNCTION create_audit_log()
RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        INSERT INTO audit_logs (entity_type, entity_id, action, old_values)
        VALUES (TG_TABLE_NAME, OLD.id, 'DELETE', row_to_json(OLD));
        RETURN OLD;
    ELSIF TG_OP = 'UPDATE' THEN
        INSERT INTO audit_logs (entity_type, entity_id, action, old_values, new_values)
        VALUES (TG_TABLE_NAME, NEW.id, 'UPDATE', row_to_json(OLD), row_to_json(NEW));
        RETURN NEW;
    ELSIF TG_OP = 'INSERT' THEN
        INSERT INTO audit_logs (entity_type, entity_id, action, new_values)
        VALUES (TG_TABLE_NAME, NEW.id, 'INSERT', row_to_json(NEW));
        RETURN NEW;
    END IF;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- Add audit triggers for important tables
CREATE TRIGGER audit_documents AFTER INSERT OR UPDATE OR DELETE ON documents
    FOR EACH ROW EXECUTE FUNCTION create_audit_log();

CREATE TRIGGER audit_document_versions AFTER INSERT OR UPDATE OR DELETE ON document_versions
    FOR EACH ROW EXECUTE FUNCTION create_audit_log();

CREATE TRIGGER audit_workflow_instances AFTER INSERT OR UPDATE OR DELETE ON workflow_instances
    FOR EACH ROW EXECUTE FUNCTION create_audit_log();

CREATE TRIGGER audit_approval_steps AFTER INSERT OR UPDATE OR DELETE ON approval_steps
    FOR EACH ROW EXECUTE FUNCTION create_audit_log();

-- ===============================
-- VIEWS FOR COMMON QUERIES
-- ===============================

-- View for documents with full details
CREATE VIEW v_documents_full AS
SELECT 
    d.*,
    dt.name as document_type_name,
    p.name as project_name,
    u.username as uploaded_by_username,
    u.first_name || ' ' || u.last_name as uploaded_by_full_name
FROM documents d
JOIN document_types dt ON d.document_type_id = dt.id
JOIN projects p ON d.project_id = p.id
JOIN users u ON d.uploaded_by = u.id;

-- View for pending approvals
CREATE VIEW v_pending_approvals AS
SELECT 
    wi.id as workflow_id,
    wi.document_id,
    d.title as document_title,
    d.file_name,
    p.name as project_name,
    as_step.id as step_id,
    as_step.step_number,
    as_step.step_name,
    as_step.approver_user_id,
    as_step.approver_role_id,
    u_approver.username as approver_username,
    r_approver.name as approver_role_name,
    wi.priority,
    as_step.due_date,
    wi.initiated_by,
    u_initiator.username as initiated_by_username
FROM workflow_instances wi
JOIN documents d ON wi.document_id = d.id
JOIN projects p ON d.project_id = p.id
JOIN approval_steps as_step ON wi.id = as_step.workflow_instance_id
LEFT JOIN users u_approver ON as_step.approver_user_id = u_approver.id
LEFT JOIN roles r_approver ON as_step.approver_role_id = r_approver.id
JOIN users u_initiator ON wi.initiated_by = u_initiator.id
WHERE wi.status = 'pending' 
  AND as_step.status = 'pending'
  AND as_step.step_number = wi.current_step;

-- Grant permissions
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO admin;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO admin;
GRANT ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA public TO admin;
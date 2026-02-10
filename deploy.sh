#!/bin/bash

# AWS Deployment Script - Direct deployment without Git
# Supports: App Runner, Elastic Beanstalk, EC2, ECS

set -e

echo "=== AWS Deployment Script ==="
echo ""
echo "Choose deployment option:"
echo "1. App Runner (Easiest)"
echo "2. Elastic Beanstalk"
echo "3. EC2 (Manual)"
echo "4. ECS/Fargate (Docker)"
echo ""
read -p "Enter option (1-4): " option

case $option in
  1)
    echo "=== Deploying to App Runner ==="
    echo ""
    echo "Prerequisites:"
    echo "1. AWS CLI installed and configured"
    echo "2. GitHub repo created"
    echo ""
    read -p "Enter GitHub repo URL: " repo_url
    read -p "Enter AWS region (default: us-east-1): " region
    region=${region:-us-east-1}
    
    echo "Steps to deploy:"
    echo "1. Push code to GitHub:"
    echo "   git init"
    echo "   git add ."
    echo "   git commit -m 'Initial commit'"
    echo "   git remote add origin $repo_url"
    echo "   git push -u origin main"
    echo ""
    echo "2. Go to AWS Console > App Runner"
    echo "3. Click 'Create service'"
    echo "4. Select 'Source code repository'"
    echo "5. Connect GitHub and select your repo"
    echo "6. Runtime: Node.js 18"
    echo "7. Build command: npm run build"
    echo "8. Start command: node server.js"
    echo "9. Add environment variables:"
    echo "   - CLAUDE_API_KEY"
    echo "   - VITE_API_BASE_URL (your App Runner URL)"
    echo "10. Deploy"
    ;;
    
  2)
    echo "=== Deploying to Elastic Beanstalk ==="
    echo ""
    read -p "Enter application name (default: instrument-dashboard): " app_name
    app_name=${app_name:-instrument-dashboard}
    read -p "Enter environment name (default: production): " env_name
    env_name=${env_name:-production}
    read -p "Enter AWS region (default: us-east-1): " region
    region=${region:-us-east-1}
    read -p "Enter CLAUDE_API_KEY: " claude_key
    
    echo ""
    echo "Installing EB CLI..."
    pip install awsebcli --quiet
    
    echo "Initializing Elastic Beanstalk..."
    eb init -p node.js-18 "$app_name" --region "$region" --quiet
    
    echo "Creating environment..."
    eb create "$env_name" --quiet
    
    echo "Setting environment variables..."
    eb setenv CLAUDE_API_KEY="$claude_key" NODE_ENV=production
    
    echo "Deploying..."
    eb deploy
    
    echo ""
    echo "✓ Deployment complete!"
    echo "Your app is running at: $(eb open --print-url)"
    ;;
    
  3)
    echo "=== EC2 Deployment (Manual) ==="
    echo ""
    read -p "Enter EC2 instance IP/DNS: " instance_ip
    read -p "Enter path to .pem key file: " key_file
    read -p "Enter EC2 user (default: ubuntu): " ec2_user
    ec2_user=${ec2_user:-ubuntu}
    
    echo ""
    echo "Uploading files to EC2..."
    scp -i "$key_file" -r . "$ec2_user@$instance_ip:/home/$ec2_user/instrument-dashboard"
    
    echo "Running setup on EC2..."
    ssh -i "$key_file" "$ec2_user@$instance_ip" << 'EOF'
      cd /home/ubuntu/instrument-dashboard
      
      # Install Node.js if not present
      if ! command -v node &> /dev/null; then
        curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
        sudo apt-get install -y nodejs
      fi
      
      # Install dependencies
      npm install
      
      # Build React app
      npm run build
      
      # Install PM2 globally
      sudo npm install -g pm2
      
      # Start app with PM2
      pm2 start server.js --name "instrument-api"
      pm2 startup
      pm2 save
      
      echo "✓ App is running on port 5000"
      echo "Access it at: http://$instance_ip:5000"
EOF
    ;;
    
  4)
    echo "=== ECS/Fargate Deployment ==="
    echo ""
    read -p "Enter AWS account ID: " account_id
    read -p "Enter AWS region (default: us-east-1): " region
    region=${region:-us-east-1}
    read -p "Enter repository name (default: instrument-dashboard): " repo_name
    repo_name=${repo_name:-instrument-dashboard}
    read -p "Enter CLAUDE_API_KEY: " claude_key
    
    echo ""
    echo "Creating ECR repository..."
    aws ecr create-repository \
      --repository-name "$repo_name" \
      --region "$region" 2>/dev/null || echo "Repository already exists"
    
    echo "Logging in to ECR..."
    aws ecr get-login-password --region "$region" | \
      docker login --username AWS --password-stdin "$account_id.dkr.ecr.$region.amazonaws.com"
    
    echo "Building Docker image..."
    docker build -t "$repo_name" .
    
    echo "Tagging image..."
    docker tag "$repo_name:latest" "$account_id.dkr.ecr.$region.amazonaws.com/$repo_name:latest"
    
    echo "Pushing to ECR..."
    docker push "$account_id.dkr.ecr.$region.amazonaws.com/$repo_name:latest"
    
    echo ""
    echo "✓ Image pushed to ECR!"
    echo ""
    echo "Next steps in AWS Console:"
    echo "1. Go to ECS > Create Cluster"
    echo "2. Create Task Definition with:"
    echo "   - Image: $account_id.dkr.ecr.$region.amazonaws.com/$repo_name:latest"
    echo "   - Port: 5000"
    echo "   - Environment variables:"
    echo "     - CLAUDE_API_KEY=$claude_key"
    echo "     - VITE_API_BASE_URL=<your-load-balancer-url>"
    echo "3. Create Service in cluster"
    echo "4. Configure load balancer (optional)"
    ;;
    
  *)
    echo "Invalid option"
    exit 1
    ;;
esac

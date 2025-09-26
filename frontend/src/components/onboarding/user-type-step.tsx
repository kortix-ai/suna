'use client';

import React, { useState, useEffect } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { useOnboarding } from '@/hooks/use-onboarding';
import { 
  User, 
  Building2, 
  Briefcase,
  Code,
  Palette,
  BarChart3,
  Users,
  Rocket,
  Crown,
  MessageSquare,
  Lightbulb,
  TrendingUp
} from 'lucide-react';
import { motion } from 'framer-motion';

// Define user types and roles
const userTypes = [
  {
    id: 'individual',
    icon: User,
    title: 'Individual',
    description: 'Freelancer, creator, or entrepreneur',
    roles: [
      { id: 'content-creator', label: 'Content Creator', icon: Palette, description: 'Writer, blogger, social media manager' },
      { id: 'developer', label: 'Developer', icon: Code, description: 'Software engineer, web developer, programmer' },
      { id: 'consultant', label: 'Consultant', icon: Briefcase, description: 'Business advisor, freelance consultant' },
      { id: 'marketer', label: 'Marketer', icon: TrendingUp, description: 'Digital marketer, growth hacker, SEO specialist' },
      { id: 'entrepreneur', label: 'Entrepreneur', icon: Rocket, description: 'Startup founder, business owner' },
      { id: 'other-individual', label: 'Other', icon: Lightbulb, description: 'Something else' }
    ]
  },
  {
    id: 'company',
    icon: Building2,
    title: 'Company',
    description: 'Business or organization',
    roles: [
      { id: 'ceo-founder', label: 'CEO/Founder', icon: Crown, description: 'Company leader, startup founder' },
      { id: 'marketing-manager', label: 'Marketing Manager', icon: TrendingUp, description: 'Head of marketing, growth lead' },
      { id: 'operations-manager', label: 'Operations Manager', icon: BarChart3, description: 'COO, operations lead, project manager' },
      { id: 'product-manager', label: 'Product Manager', icon: Briefcase, description: 'Product lead, product owner' },
      { id: 'team-lead', label: 'Team Lead', icon: Users, description: 'Department head, team manager' },
      { id: 'other-company', label: 'Other Role', icon: MessageSquare, description: 'Different company role' }
    ]
  }
];

interface UserTypeStepProps {
  onUserTypeChange?: (userType: string, role?: string) => void;
}

export const UserTypeStep: React.FC<UserTypeStepProps> = ({ onUserTypeChange }) => {
  const { userTypeData, setUserTypeData } = useOnboarding();
  const [selectedType, setSelectedType] = useState<string>(userTypeData.userType || '');
  const [selectedRole, setSelectedRole] = useState<string>(userTypeData.role || '');

  const handleTypeSelect = (typeId: string) => {
    setSelectedType(typeId);
    setSelectedRole(''); // Reset role when type changes
    setUserTypeData({ userType: typeId as 'individual' | 'company' });
    onUserTypeChange?.(typeId);
  };

  const handleRoleSelect = (roleId: string) => {
    setSelectedRole(roleId);
    setUserTypeData({ 
      userType: selectedType as 'individual' | 'company', 
      role: roleId 
    });
    onUserTypeChange?.(selectedType, roleId);
  };

  // Load saved data on mount
  useEffect(() => {
    if (userTypeData.userType) {
      setSelectedType(userTypeData.userType);
    }
    if (userTypeData.role) {
      setSelectedRole(userTypeData.role);
    }
  }, [userTypeData]);

  const selectedTypeData = userTypes.find(type => type.id === selectedType);

  return (
    <div className="space-y-8 max-w-4xl mx-auto">
      {/* Header */}
      <div className="text-center space-y-4">
        <h3 className="text-2xl font-semibold text-foreground">
          Tell us about yourself
        </h3>
        <p className="text-lg text-muted-foreground">
          This helps us customize your AI experience
        </p>
      </div>

      {/* User Type Selection */}
      <div className="space-y-4">
        <Label className="text-base font-medium">I am a...</Label>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {userTypes.map((type, index) => {
            const IconComponent = type.icon;
            return (
              <motion.div
                key={type.id}
                initial={{ y: 20, opacity: 0 }}
                animate={{ y: 0, opacity: 1 }}
                transition={{ delay: index * 0.1 }}
              >
                <Card 
                  className={`cursor-pointer transition-all hover:shadow-md ${
                    selectedType === type.id ? 'ring-2 ring-primary bg-primary/5' : 'hover:border-primary/50'
                  }`}
                  onClick={() => handleTypeSelect(type.id)}
                >
                  <CardContent className="p-6 text-center">
                    <IconComponent className="h-12 w-12 mx-auto mb-4 text-primary" />
                    <CardTitle className="mb-2">{type.title}</CardTitle>
                    <CardDescription>{type.description}</CardDescription>
                  </CardContent>
                </Card>
              </motion.div>
            );
          })}
        </div>
      </div>

      {/* Role Selection */}
      {selectedTypeData && (
        <motion.div
          initial={{ y: 20, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          transition={{ duration: 0.3 }}
          className="space-y-4"
        >
          <Label className="text-base font-medium">What's your role?</Label>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
            {selectedTypeData.roles.map((role, index) => {
              const RoleIcon = role.icon;
              return (
                <motion.div
                  key={role.id}
                  initial={{ y: 10, opacity: 0 }}
                  animate={{ y: 0, opacity: 1 }}
                  transition={{ delay: index * 0.05 }}
                >
                  <Card 
                    className={`cursor-pointer transition-all hover:shadow-sm ${
                      selectedRole === role.id 
                        ? 'ring-2 ring-primary bg-primary/5' 
                        : 'hover:border-primary/30'
                    }`}
                    onClick={() => handleRoleSelect(role.id)}
                  >
                    <CardContent className="p-4">
                      <div className="flex items-start gap-3">
                        <div className="flex-shrink-0 p-2 bg-muted rounded-lg">
                          <RoleIcon className="h-4 w-4 text-foreground" />
                        </div>
                        <div className="flex-1 min-w-0">
                          <h4 className="font-medium text-sm mb-1">{role.label}</h4>
                          <p className="text-xs text-muted-foreground leading-relaxed">
                            {role.description}
                          </p>
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                </motion.div>
              );
            })}
          </div>
        </motion.div>
      )}

      {/* Selected Summary */}
      {selectedType && selectedRole && (
        <motion.div
          initial={{ y: 20, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          transition={{ duration: 0.3 }}
          className="bg-muted/50 rounded-lg p-6 text-center"
        >
          <div className="flex items-center justify-center gap-2 mb-2">
            <Badge variant="secondary" className="flex items-center gap-1">
              {selectedTypeData?.icon && <selectedTypeData.icon className="h-3 w-3" />}
              {selectedTypeData?.title}
            </Badge>
            <span className="text-muted-foreground">•</span>
            <Badge variant="outline">
              {selectedTypeData?.roles.find(r => r.id === selectedRole)?.label}
            </Badge>
          </div>
          <p className="text-sm text-muted-foreground">
            Perfect! We'll customize your AI experience for your needs.
          </p>
        </motion.div>
      )}
    </div>
  );
};
